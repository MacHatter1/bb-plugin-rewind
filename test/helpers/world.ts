// A small fake BB for server tests: threads with event logs, environments,
// and the plugin loaded into the SDK's fake plugin host. Host RPC goes to the
// real host handlers against temp directories, so snapshots and restores run
// real git.
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import path from "node:path";
import plugin from "../../server";
import { createHostHandlers } from "../../src/host/handlers";
import { tempDir } from "./fs";

export const HOST_ID = "host_test";

export type QueuedRow = MessageDispatchHookContext["queuedMessages"][number];

let rowCounter = 0;

/** A queued message row as core hands it to hooks and `message.*` events. */
export function queuedRow(threadId: string, overrides: Partial<QueuedRow> = {}): QueuedRow {
  rowCounter += 1;
  const now = Date.now();
  return {
    id: `qm_test${rowCounter.toString().padStart(4, "0")}`,
    threadId,
    content: [{ type: "text", text: "please change the files", mentions: [] }],
    createdAt: now,
    updatedAt: now,
    editable: true,
    failureReason: null,
    groupWithNext: false,
    initiator: "user",
    model: "test-model",
    origin: "app",
    originPluginId: null,
    payload: { kind: "inline" },
    permissionMode: "auto",
    reasoningLevel: "medium",
    sendAt: null,
    senderThreadId: null,
    serviceTier: "default",
    waitingOn: { kind: "plugin", pluginId: "rewind", reason: "Rewind: saving a checkpoint…" },
    ...overrides,
  };
}
export const PROJECT_ID = "proj_test";

export interface FakeThread {
  id: string;
  projectId: string;
  environmentId: string | null;
  status: "idle" | "active" | "starting" | "stopping" | "error" | "pending";
  title: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
  sourceThreadId: string | null;
  visibility: "visible" | "hidden";
  providerId: string;
  events: Array<{ seq: number; type: string; data: Record<string, unknown> }>;
  conversation: Array<{
    kind: "conversation";
    role: "user" | "assistant";
    sourceSeqEnd: number;
    text: string;
    turnRequest: { kind: "message" | "steer"; status: "accepted"; isGrouped: boolean } | null;
    initiator?: "user" | "agent";
    turnId?: string;
  }>;
}

export interface FakeEnvironment {
  id: string;
  hostId: string;
  path: string | null;
  status: "ready" | "provisioning" | "error" | "destroyed" | "creating";
  isGitRepo: boolean;
}

type HostCallHook = (method: string, input: unknown) => Promise<void> | void;

export interface WorldOptions {
  settings?: Record<string, string | number | boolean>;
  /** Called before each host RPC (inject delays or failures). */
  beforeHostCall?: HostCallHook;
  /** Creates the environment for a new fork (tests make a git worktree). */
  onFork?: (args: Record<string, unknown>, fork: FakeThread) => Promise<FakeEnvironment | null>;
  /** Fail event reads that filter by type (the plugin must filter locally). */
  rejectTypeFilter?: boolean;
  /** `threads.editMessage`; throw to have bb refuse the edit. Default: accept. */
  onEditMessage?: (args: Record<string, unknown>) => Promise<void> | void;
  /** Where `threads.storageLocation` says a thread's storage is. Default: outside every workspace. */
  storageRoot?: (threadId: string) => string;
}

export async function createWorld(options: WorldOptions = {}) {
  const dataDir = await tempDir("host-data");
  const handlers = createHostHandlers(dataDir);
  const threads = new Map<string, FakeThread>();
  const environments = new Map<string, FakeEnvironment>();
  const hostCalls: Array<{ method: string; input: unknown }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const edits: Array<Record<string, unknown>> = [];
  let beforeHostCall: HostCallHook | undefined = options.beforeHostCall;
  let counter = 0;

  const threadResponse = (thread: FakeThread) =>
    makeThreadResponse({
      id: thread.id,
      projectId: thread.projectId,
      environmentId: thread.environmentId,
      status: thread.status,
      title: thread.title,
      archivedAt: thread.archivedAt,
      deletedAt: thread.deletedAt,
      sourceThreadId: thread.sourceThreadId,
      visibility: thread.visibility,
      providerId: thread.providerId,
      runtime: { displayStatus: thread.status, hostReconnectGraceExpiresAt: null },
    });

  const environmentResponse = (environment: FakeEnvironment) => ({
    id: environment.id,
    hostId: environment.hostId,
    path: environment.path,
    status: environment.status,
    isGitRepo: environment.isGitRepo,
    isWorktree: false,
    projectId: PROJECT_ID,
    baseBranch: null,
    branchName: null,
    defaultBranch: null,
    lifecycle: { phase: "active", retireAt: null, teardown: null },
  });

  const requireThread = (threadId: string) => {
    const thread = threads.get(threadId);
    if (thread === undefined) throw new Error(`404 thread ${threadId} not found`);
    return thread;
  };

  const { bb, harness } = createFakePluginHost({
    pluginId: "rewind",
    // Tests edit files right after a dispatch, so by default the gate holds
    // long enough for a snapshot to finish; gate tests set short holds.
    settings: { gateHoldMs: 2_000, ...options.settings },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => threadResponse(requireThread(threadId)),
        list: async ({ environmentId }: { environmentId?: string }) =>
          [...threads.values()]
            .filter((thread) => environmentId === undefined || thread.environmentId === environmentId)
            .filter((thread) => thread.deletedAt === null)
            .map((thread) => ({
              id: thread.id,
              title: thread.title,
              titleFallback: null,
              status: thread.status,
              archivedAt: thread.archivedAt,
              environmentId: thread.environmentId,
              runtime: { displayStatus: thread.status, hostReconnectGraceExpiresAt: null },
            })),
        events: {
          list: async ({
            threadId,
            order,
            limit,
            types,
            afterSeq,
            beforeSeq,
          }: {
            threadId: string;
            order?: string;
            limit?: string;
            types?: readonly string[];
            afterSeq?: string;
            beforeSeq?: string;
          }) => {
            if (types !== undefined && options.rejectTypeFilter === true) throw new Error("400 unsupported types filter");
            let rows = requireThread(threadId).events.filter(
              (event) =>
                (types === undefined || types.includes(event.type)) &&
                (afterSeq === undefined || event.seq > Number(afterSeq)) &&
                (beforeSeq === undefined || event.seq < Number(beforeSeq)),
            );
            if (order === "desc") rows = [...rows].reverse();
            return rows.slice(0, limit === undefined ? rows.length : Number(limit)).map((event) => ({ ...event, threadId, id: `ev_${event.seq}`, scope: "thread", createdAt: 0 }));
          },
        },
        stop: async ({ threadId }: { threadId: string }) => {
          requireThread(threadId).status = "idle";
          return { ok: true };
        },
        storageLocation: async ({ threadId }: { threadId: string }) => {
          requireThread(threadId);
          return { hostId: HOST_ID, storageRootPath: options.storageRoot?.(threadId) ?? path.join(dataDir, "thread-storage", threadId) };
        },
        timeline: async ({ threadId }: { threadId: string }) => ({ rows: requireThread(threadId).conversation, maxSeq: 0 }),
        fork: async (args: Record<string, unknown>) => {
          const source = requireThread(String(args.sourceThreadId));
          const fork = addThread({ projectId: source.projectId, environmentId: null, title: String(args.title ?? "fork"), sourceThreadId: source.id });
          const environment = options.onFork === undefined ? null : await options.onFork(args, fork);
          if (environment !== null) {
            environments.set(environment.id, environment);
            fork.environmentId = environment.id;
          }
          return threadResponse(fork);
        },
        send: async (args: Record<string, unknown>) => {
          sent.push(args);
          return { ok: true };
        },
        editMessage: async (args: Record<string, unknown>) => {
          edits.push(args);
          await options.onEditMessage?.(args);
          // Like bb: the edited message and every later row go; the new text
          // is a new request.
          const thread = requireThread(String(args.threadId));
          const at = thread.conversation.findIndex((row) => row.role === "user" && row.sourceSeqEnd === Number(args.expectedRequestSequence));
          if (at !== -1) thread.conversation.splice(at);
          appendEvent(thread.id, "system/operation");
          const input = args.input as Array<{ text: string }>;
          const requestSequence = userMessage(thread.id, input.map((block) => block.text).join("\n"));
          return { ok: true, operationId: String(args.operationId), requestSequence };
        },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => {
          const environment = environments.get(environmentId);
          if (environment === undefined) throw new Error(`404 environment ${environmentId}`);
          return environmentResponse(environment);
        },
        list: async ({ hostId }: { hostId?: string }) =>
          [...environments.values()].filter((environment) => hostId === undefined || environment.hostId === hostId).map(environmentResponse),
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({ id: projectId, name: "Test project" }),
      },
      hosts: {
        list: async () => [makeHostResponse({ id: HOST_ID })],
      },
      providers: {
        list: async () => ({
          providers: [
            { id: "codex", capabilities: { supportsSessionRewind: true } },
            { id: "acp-cursor", capabilities: { supportsSessionRewind: false } },
          ],
        }),
      },
    } as never,
    experimental_callHostRpc: async ({ method, input, signal }) => {
      hostCalls.push({ method, input });
      await beforeHostCall?.(method, input);
      const handler = (handlers as unknown as Record<string, (input: unknown, context: unknown) => Promise<unknown>>)[method];
      if (handler === undefined) throw new Error(`no host handler ${method}`);
      const controller = new AbortController();
      return handler(input, {
        signal: signal ?? controller.signal,
        lifecycle: { signal: controller.signal },
        experimental_paths: { dataDir, tempDir: dataDir },
      });
    },
  });
  await plugin(bb);

  function addThread(input: Partial<FakeThread> & { projectId?: string }): FakeThread {
    counter += 1;
    const thread: FakeThread = {
      id: input.id ?? `thr_test${counter.toString().padStart(4, "0")}`,
      projectId: input.projectId ?? PROJECT_ID,
      environmentId: input.environmentId ?? null,
      status: input.status ?? "idle",
      title: input.title ?? `Thread ${counter}`,
      archivedAt: input.archivedAt ?? null,
      deletedAt: input.deletedAt ?? null,
      sourceThreadId: input.sourceThreadId ?? null,
      visibility: input.visibility ?? "visible",
      providerId: input.providerId ?? "codex",
      events: [],
      conversation: [],
    };
    threads.set(thread.id, thread);
    return thread;
  }

  function addEnvironment(path: string, overrides: Partial<FakeEnvironment> = {}): FakeEnvironment {
    counter += 1;
    const environment: FakeEnvironment = {
      id: `env_test${counter.toString().padStart(4, "0")}`,
      hostId: HOST_ID,
      path,
      status: "ready",
      isGitRepo: true,
      ...overrides,
    };
    environments.set(environment.id, environment);
    return environment;
  }

  function appendEvent(threadId: string, type: string, data: Record<string, unknown> = {}): number {
    const thread = requireThread(threadId);
    const seq = (thread.events.at(-1)?.seq ?? 0) + 1;
    thread.events.push({ seq, type, data });
    return seq;
  }

  /** Record a user message (its conversation row) and return its sourceSeqEnd. */
  function userMessage(threadId: string, text: string, options: { initiator?: "user" | "agent"; turnId?: string } = {}): number {
    const seq = appendEvent(threadId, "client/turn/requested", { text });
    requireThread(threadId).conversation.push({
      kind: "conversation",
      role: "user",
      sourceSeqEnd: seq,
      text,
      initiator: options.initiator ?? "user",
      turnId: options.turnId ?? `turn_${seq}`,
      turnRequest: { kind: "message", status: "accepted", isGrouped: false },
    });
    return seq;
  }

  /** A shell command the agent started, as providers report it. */
  function command(threadId: string, commandLine: string, cwd = ""): number {
    return appendEvent(threadId, "item/started", { item: { type: "commandExecution", id: `cmd_${counter}`, command: commandLine, cwd, status: "pending" } });
  }

  function assistantMessage(threadId: string, text: string): number {
    appendEvent(threadId, "turn/started");
    appendEvent(threadId, "item/started", { item: { type: "agentMessage" } });
    const seq = appendEvent(threadId, "item/completed", { item: { type: "agentMessage", text } });
    requireThread(threadId).conversation.push({ kind: "conversation", role: "assistant", sourceSeqEnd: seq, text, turnRequest: null });
    appendEvent(threadId, "turn/completed");
    return seq;
  }

  function dispatchContext(thread: FakeThread, overrides: Parameters<typeof makeMessageDispatchHookContext>[0] = {}): MessageDispatchHookContext {
    const environment = thread.environmentId === null ? null : environments.get(thread.environmentId) ?? null;
    return makeMessageDispatchHookContext({
      thread: { id: thread.id, projectId: thread.projectId, status: thread.status, environmentId: thread.environmentId, title: thread.title },
      project: { id: thread.projectId, name: "Test project" },
      environment:
        environment === null
          ? null
          : { id: environment.id, hostId: environment.hostId, path: environment.path, status: environment.status, isGitRepo: environment.isGitRepo },
      attempt: "start-turn",
      initiator: "user",
      input: { text: "please change the files", blocks: [] },
      ...overrides,
    });
  }

  async function dispatch(thread: FakeThread, overrides: Parameters<typeof makeMessageDispatchHookContext>[0] = {}) {
    const hook = harness.inspection.registrations.hooks["message.dispatch"];
    if (hook === null) throw new Error("the plugin registered no dispatch hook");
    return hook(dispatchContext(thread, overrides));
  }

  async function rpc<T = unknown>(method: string, input?: unknown): Promise<T> {
    return (await harness.behavior.callRpc(method, input)) as T;
  }

  /** Wait until the checkpoint leaves "pending" (background snapshots). */
  async function settled(checkpointId: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const threadId of threads.keys()) {
        const listed = await rpc<{ checkpoints: Array<{ id: string; status: string; late: boolean }> }>("list", { threadId });
        const row = listed.checkpoints.find((checkpoint) => checkpoint.id === checkpointId);
        if (row !== undefined && row.status !== "pending") return row;
      }
      if (Date.now() > deadline) throw new Error(`checkpoint ${checkpointId} still pending`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  return {
    bb,
    harness,
    dataDir,
    threads,
    environments,
    hostCalls,
    sent,
    edits,
    addThread,
    addEnvironment,
    appendEvent,
    userMessage,
    assistantMessage,
    dispatch,
    dispatchContext,
    command,
    rpc,
    settled,
    setBeforeHostCall(hook: HostCallHook | undefined) {
      beforeHostCall = hook;
    },
  };
}

export type World = Awaited<ReturnType<typeof createWorld>>;
