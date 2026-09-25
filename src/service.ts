// Rewind's server-side logic: the dispatch gate, lifecycle snapshots, message
// mapping, restores, forks, and retention. server.ts wires it to BB; tests
// drive it through the fake plugin host.
import type {
  ExperimentalHostClient,
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
  PluginBbSdk,
  PluginLogger,
} from "@get-bb/plugin-sdk";
import {
  BB_CHAT_DIR,
  EXCERPT_CHARS,
  FORK_ENVIRONMENT_WAIT_MS,
  GATE_WAIT_CAP_MS,
  PLUGIN_ID,
  WAIT_REASON_RESTORE,
  WAIT_REASON_SNAPSHOT,
  MAX_PATCH_BYTES_PER_FILE,
  MAX_PATCH_BYTES_TOTAL,
  PENDING_STALE_MS,
  RESTORE_TIMEOUT_MS,
  DIFF_TIMEOUT_MS,
  SNAPSHOT_TIMEOUT_MS,
  STORAGE_LOOKUP_MS,
  STORAGE_RETRY_MS,
  GC_TIMEOUT_MS,
  WORKSPACE_MAX_BYTES,
  WORKSPACE_MAX_FILES,
} from "./constants";
import { absolutePathSchema, type CheckpointKind, type HostContract, type Revision, type SnapshotLimits } from "./host-contract";
import { newId } from "./ids";
import { resolveMessageCheckpoint } from "./mapping";
import { selectForDeletion } from "./retention";
import type {
  CheckpointDto,
  ForkJob,
  RestoreDto,
  RestoreOutcome,
  RunningThread,
  UndoneEffect,
  WorkspaceInfo,
} from "./rpc-contract";
import { groupTurns } from "./turns";
import { detectEffects } from "./effects";
import type { EditResult } from "./format";
import { isProjectExcluded, type RewindSettings } from "./settings";
import type {
  CheckpointRow,
  DispatchAttempt,
  ForkRow,
  GateWaitKind,
  GateWaitRow,
  RestoreKind,
  RestoreRow,
  RewindStore,
  StoredEffect,
} from "./store";

export class RewindError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "RewindError";
    this.code = code;
    this.hint = hint;
  }
}

type HostClient = ExperimentalHostClient<HostContract>;
type ThreadDto = Awaited<ReturnType<PluginBbSdk["threads"]["get"]>>;

export interface ServiceDeps {
  sdk: () => PluginBbSdk;
  host: HostClient;
  store: RewindStore;
  settings: () => RewindSettings;
  log: PluginLogger;
  publish: (threadId: string) => void;
  /** Ask core to re-attempt messages queued behind plugin waits. */
  recheck?: () => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type QueuedRow = MessageDispatchHookContext["queuedMessages"][number];

/** What the gate decided about one dispatch attempt. */
export interface GateResult {
  decision: MessageDispatchHookDecision;
  outcome: string;
  checkpointId: string | null;
  /** How long the hook held the message (the server-wide lock). */
  heldMs: number;
}

const PROCEED: MessageDispatchHookDecision = { action: "proceed" };
/** The event mark read is part of the hold; never wait long for it. */
const MARK_WAIT_MS = 250;
/** Open waits older than this after a restart are closed as stale. */
const STALE_WAIT_MS = 60 * 60 * 1000;

/** Timeline pages (of 100 segments, bb's maximum) read to number a thread's messages. */
const TIMELINE_PAGES = 30;
/** Command starts read per checkpoint range: pages of this size (bb's maximum), at most this many. */
const EFFECT_PAGE = 100;
const EFFECT_PAGES = 30;
const MAX_EFFECTS_PER_RANGE = 20;
/** Checkpoints whose range a preview or restore scans inline; older ones fill in the background. */
const EFFECT_ROWS_INLINE = 40;

export type { EditResult } from "./format";

export interface ResolvedWorkspace {
  environmentId: string;
  hostId: string;
  path: string;
  isGit: boolean | null;
  projectId: string | null;
}

const RUNNING_STATUSES = new Set(["starting", "active", "stopping"]);

/** A queued row's wait that Rewind issued: its own, or its reason appended to another plugin's. */
function isRewindWait(waitingOn: QueuedRow["waitingOn"]): boolean {
  if (waitingOn?.kind !== "plugin") return false;
  return waitingOn.pluginId === PLUGIN_ID || waitingOn.reason.includes(WAIT_REASON_SNAPSHOT) || waitingOn.reason.includes(WAIT_REASON_RESTORE);
}
/** Item kinds that only talk; anything else may have touched files. */
const PASSIVE_ITEM_TYPES = new Set([
  "agentMessage",
  "userMessage",
  "reasoning",
  "plan",
  "planSteps",
  "contextCompaction",
  "webSearch",
  "webFetch",
  "fileRead",
  "read",
  "search",
  "listFiles",
  "imageView",
]);

export function excerpt(text: string | null | undefined, max = EXCERPT_CHARS): string | null {
  if (typeof text !== "string") return null;
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

/** bb's chat copies, which Rewind 0.1 captured: never shown, even in old checkpoints. */
function bbChatPath(file: string): boolean {
  return file === BB_CHAT_DIR || file.startsWith(`${BB_CHAT_DIR}/`);
}

function withoutBbChats(row: CheckpointRow): Pick<CheckpointDto, "stats" | "changes"> {
  const hidden = row.changes.filter((change) => bbChatPath(change.path));
  if (hidden.length === 0) return { stats: row.stats, changes: row.changes };
  const sum = (field: "additions" | "deletions") => hidden.reduce((total, change) => total + (change[field] ?? 0), 0);
  return {
    stats:
      row.stats === null
        ? null
        : {
            files: Math.max(0, row.stats.files - hidden.length),
            insertions: Math.max(0, row.stats.insertions - sum("additions")),
            deletions: Math.max(0, row.stats.deletions - sum("deletions")),
          },
    changes: row.changes.filter((change) => !bbChatPath(change.path)),
  };
}

export function toCheckpointDto(row: CheckpointRow): CheckpointDto {
  return {
    id: row.id,
    threadId: row.threadId,
    environmentId: row.environmentId,
    hostId: row.hostId,
    workspace: row.workspace,
    kind: row.kind,
    label: row.label,
    attempt: row.attempt,
    status: row.status,
    late: row.late,
    deduped: row.deduped,
    eventMark: row.eventMark,
    messageExcerpt: row.messageExcerpt,
    commit: row.commit,
    head: row.head,
    baseline: row.baseline,
    ...withoutBbChats(row),
    changesTruncated: row.changesTruncated,
    skipped: row.skipped,
    skippedCount: row.skippedCount,
    durationMs: row.durationMs,
    error: row.error,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    effects: row.effects,
  };
}

export function toRestoreDto(row: RestoreRow): RestoreDto {
  return {
    id: row.id,
    threadId: row.threadId,
    kind: row.kind,
    targetCheckpointId: row.targetCheckpointId,
    preRestoreCheckpointId: row.preRestoreCheckpointId,
    status: row.status,
    summary: row.summary,
    error: row.error,
    undoneBy: row.undoneBy,
    createdAt: row.createdAt,
  };
}

function toForkJob(row: ForkRow): ForkJob {
  return {
    id: row.id,
    sourceThreadId: row.sourceThreadId,
    checkpointId: row.checkpointId,
    forkThreadId: row.forkThreadId,
    status: row.status,
    step: row.step,
    error: row.error,
  };
}

interface ConversationRow {
  role: "user" | "assistant";
  sourceSeqEnd: number;
  text: string;
  /** The turn the row belongs to; the first user row of a turn started it. */
  turnId: string | null;
  requestStatus: string | null;
  /** Who sent a user row: "user" (typed), "agent" (another thread), or "system". */
  initiator: string | null;
}

/** A user message that started a turn, numbered from 1 when the whole history was read. */
export interface UserMessage {
  number: number | null;
  sourceSeqEnd: number;
  text: string;
  /** Typed by the user: bb edits only those, not messages another thread sent. */
  fromUser: boolean;
}

/** Flatten timeline rows (turn rows nest their children) to conversation rows. */
export function conversationRows(rows: readonly unknown[]): ConversationRow[] {
  const out: ConversationRow[] = [];
  const visit = (row: unknown) => {
    if (typeof row !== "object" || row === null) return;
    const record = row as Record<string, unknown>;
    if (record.kind === "conversation" && (record.role === "user" || record.role === "assistant") && typeof record.sourceSeqEnd === "number") {
      const request = typeof record.turnRequest === "object" && record.turnRequest !== null ? (record.turnRequest as Record<string, unknown>) : null;
      out.push({
        role: record.role,
        sourceSeqEnd: record.sourceSeqEnd,
        text: typeof record.text === "string" ? record.text : "",
        turnId: typeof record.turnId === "string" ? record.turnId : null,
        requestStatus: typeof request?.status === "string" ? request.status : null,
        initiator: typeof record.initiator === "string" ? record.initiator : null,
      });
    }
    if (Array.isArray(record.children)) for (const child of record.children) visit(child);
  };
  for (const row of rows) visit(row);
  return out.sort((a, b) => a.sourceSeqEnd - b.sourceSeqEnd);
}

/**
 * The fork anchor for a checkpoint: a before-turn checkpoint branches before
 * the message it preceded; any other checkpoint branches after the last
 * reply it includes. Undefined means "fork the whole conversation".
 */
export function anchorForCheckpoint(checkpoint: Pick<CheckpointRow, "kind" | "eventMark">, rows: readonly ConversationRow[]): number | undefined {
  if (checkpoint.eventMark === null) return undefined;
  const mark = checkpoint.eventMark;
  if (checkpoint.kind === "before-turn") {
    return rows.find((row) => row.role === "user" && row.sourceSeqEnd >= mark)?.sourceSeqEnd;
  }
  return [...rows].reverse().find((row) => row.role === "assistant" && row.sourceSeqEnd <= mark)?.sourceSeqEnd;
}

export class RewindService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly background = new Set<Promise<unknown>>();
  /** Restores writing files, per environment. */
  private readonly restoring = new Map<string, number>();
  /** Excerpts of messages queued behind a restore, for their checkpoints. */
  private readonly waitExcerpts = new Map<string, string | null>();
  /** Messages released at the safety cap while a restore still ran, per environment. */
  private readonly restoreCapReleases = new Map<string, string[]>();
  /** Gate snapshots still running, by checkpoint id. */
  private readonly jobs = new Map<string, Promise<CheckpointRow>>();
  /** Checkpoints whose message went out before they finished: when it did. */
  private readonly released = new Map<string, number>();
  /** Open waits (messages Rewind queued) by thread, and by queued row. */
  private readonly waitsByThread = new Map<string, GateWaitRow>();
  private readonly waitByRow = new Map<string, GateWaitRow>();
  /** Effect scans in flight, so a re-list does not start the same scan twice. */
  private readonly scans = new Map<string, Promise<StoredEffect[]>>();
  /** Where bb keeps each thread's own storage (it never moves), and lookups that failed recently. */
  private readonly storageRoots = new Map<string, { hostId: string; path: string }>();
  private readonly storageLookups = new Map<string, Promise<{ hostId: string; path: string } | null>>();
  private readonly storageMisses = new Map<string, number>();
  /** Which providers can replace a message (bb's session rewind), cached briefly. */
  private providerEdits: { at: number; byProvider: Map<string, boolean> } | null = null;
  private disposed = false;

  constructor(private readonly deps: ServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.loadWaits();
  }

  private get sdk(): PluginBbSdk {
    return this.deps.sdk();
  }

  private get store(): RewindStore {
    return this.deps.store;
  }

  private limits(settings = this.deps.settings()): SnapshotLimits {
    return { maxFileBytes: settings.maxFileBytes, maxFiles: WORKSPACE_MAX_FILES, maxTotalBytes: WORKSPACE_MAX_BYTES };
  }

  /** Track fire-and-forget work so dispose can wait for it. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.background.add(work);
    void work.finally(() => this.background.delete(work)).catch(() => undefined);
    return work;
  }

  async dispose(timeoutMs = 4_000): Promise<void> {
    this.disposed = true;
    await Promise.race([Promise.allSettled([...this.background]), this.sleep(timeoutMs)]);
  }

  // ------------------------------------------------------------ lookups

  async eventMark(threadId: string): Promise<number | null> {
    try {
      const rows = await this.sdk.threads.events.list({ threadId, order: "desc", limit: "1" });
      const seq = rows[0]?.seq;
      return typeof seq === "number" ? seq : 0;
    } catch (error) {
      this.deps.log.warn(`could not read the event mark of ${threadId}: ${errorText(error)}`);
      return null;
    }
  }

  private async getThread(threadId: string): Promise<ThreadDto> {
    try {
      return await this.sdk.threads.get({ threadId });
    } catch (error) {
      throw new RewindError("thread_not_found", `Thread ${threadId} was not found: ${errorText(error)}`);
    }
  }

  async resolveWorkspace(threadId: string): Promise<{ thread: ThreadDto; workspace: ResolvedWorkspace }> {
    const thread = await this.getThread(threadId);
    if (thread.environmentId === null) {
      throw new RewindError("no_environment", "This thread has no workspace yet. Checkpoints start once its environment is ready.");
    }
    const environment = await this.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.status === "error" || environment.status === "destroyed") {
      throw new RewindError("environment_failed", `The thread's environment is ${environment.status}; its files are not available.`);
    }
    if (environment.status !== "ready" || environment.path === null) {
      throw new RewindError("environment_not_ready", `The thread's environment is ${environment.status}; its files are not available yet.`);
    }
    return {
      thread,
      workspace: {
        environmentId: environment.id,
        hostId: environment.hostId,
        path: environment.path,
        isGit: environment.isGitRepo,
        projectId: thread.projectId,
      },
    };
  }

  async runningThreads(environmentId: string, selfId: string): Promise<RunningThread[]> {
    const threads = await this.sdk.threads.list({ environmentId, includeHidden: true, limit: 200 });
    return threads
      .filter((thread) => thread.archivedAt === null && (RUNNING_STATUSES.has(thread.status) || RUNNING_STATUSES.has(thread.runtime.displayStatus)))
      .map((thread) => ({ id: thread.id, title: thread.title ?? thread.titleFallback, status: thread.status, isSelf: thread.id === selfId }));
  }

  private async workspaceInfo(threadId: string, workspace: ResolvedWorkspace): Promise<WorkspaceInfo> {
    const threads = await this.sdk.threads.list({ environmentId: workspace.environmentId, includeHidden: true, limit: 200 }).catch(() => []);
    const running = threads
      .filter((thread) => thread.archivedAt === null && (RUNNING_STATUSES.has(thread.status) || RUNNING_STATUSES.has(thread.runtime.displayStatus)))
      .map((thread) => ({ id: thread.id, title: thread.title ?? thread.titleFallback, status: thread.status, isSelf: thread.id === threadId }));
    let unsupported: string | null = null;
    try {
      const status = await this.deps.host.call("status", { workspace: workspace.path, measureSize: false }, { hostId: workspace.hostId, timeoutMs: 15_000 });
      unsupported = status.unsupported?.reason ?? null;
    } catch {
      unsupported = null;
    }
    return {
      environmentId: workspace.environmentId,
      hostId: workspace.hostId,
      path: workspace.path,
      isGit: workspace.isGit,
      sharedWith: threads.filter((thread) => thread.id !== threadId && thread.archivedAt === null).length,
      running,
      unsupported,
    };
  }

  private requireCheckpoint(checkpointId: string): CheckpointRow {
    const checkpoint = this.store.getCheckpoint(checkpointId);
    if (checkpoint === null) throw new RewindError("checkpoint_not_found", `Checkpoint ${checkpointId} does not exist.`, "Run `bb rewind list` to see this thread's checkpoints.");
    if (checkpoint.status === "pending") throw new RewindError("checkpoint_pending", `Checkpoint ${checkpointId} is still being captured. Try again in a moment.`);
    if (checkpoint.status !== "ok" || checkpoint.commit === null) {
      throw new RewindError("checkpoint_unusable", `Checkpoint ${checkpointId} has no files: ${checkpoint.error ?? checkpoint.status}.`);
    }
    return checkpoint;
  }

  /** Where the target checkpoint's objects live relative to the workspace. */
  private sourceFor(checkpoint: CheckpointRow, workspace: ResolvedWorkspace): string | null {
    if (checkpoint.hostId !== workspace.hostId) {
      throw new RewindError(
        "checkpoint_on_other_machine",
        `Checkpoint ${checkpoint.id} was taken on another machine (${checkpoint.hostId}); it can only be restored there.`,
      );
    }
    return checkpoint.workspace === workspace.path ? null : checkpoint.workspace;
  }

  // ---------------------------------------------------------- snapshots

  /**
   * `late` marks a checkpoint that may include the start of its turn: one
   * whose message was released (see `released`) before it finished.
   */
  private async runSnapshot(row: CheckpointRow, options: { force?: boolean; compareTo?: string | null } = {}): Promise<CheckpointRow> {
    const started = this.now();
    const settings = this.deps.settings();
    const previous = options.compareTo !== undefined ? options.compareTo : this.previousCommit(row);
    let updated: CheckpointRow | null = null;
    try {
      const result = await this.deps.host.call(
        "snapshot",
        {
          workspace: row.workspace,
          checkpointId: row.id,
          kind: row.kind,
          subject: `${row.kind} ${row.id} (${row.threadId})`,
          compareTo: previous,
          limits: this.limits(settings),
          excludePaths: await this.excludePaths(row.threadId, row.hostId),
          force: options.force === true,
        },
        { hostId: row.hostId, timeoutMs: SNAPSHOT_TIMEOUT_MS },
      );
      const completedAt = this.now();
      const late = this.releasedBefore(row.id, completedAt);
      if (result.status === "ok") {
        updated = this.store.completeCheckpoint(
          row.id,
          { ...result, baseline: result.comparedTo === null },
          { late, completedAt },
        );
      } else if (result.status === "unsupported") {
        updated = this.store.failCheckpoint(row.id, "unsupported", result.reason, { late, completedAt, durationMs: completedAt - started });
      } else {
        updated = this.store.failCheckpoint(row.id, "failed", result.reason, { late, completedAt, durationMs: completedAt - started });
      }
    } catch (error) {
      const completedAt = this.now();
      this.deps.log.warn(`snapshot ${row.id} of ${row.workspace} failed: ${errorText(error)}`);
      updated = this.store.failCheckpoint(row.id, "failed", errorText(error), {
        late: this.releasedBefore(row.id, completedAt),
        completedAt,
        durationMs: completedAt - started,
      });
    }
    this.released.delete(row.id);
    this.deps.publish(row.threadId);
    const done = updated ?? row;
    // What the commands before this checkpoint did outside the workspace.
    if (done.eventMark !== null && !this.disposed) void this.track(this.ensureEffects(done).catch(() => []));
    return done;
  }

  private releasedBefore(checkpointId: string, completedAt: number): boolean {
    const at = this.released.get(checkpointId);
    return at !== undefined && completedAt > at;
  }

  /** The thread's previous successful checkpoint commit (stats baseline). */
  private previousCommit(row: CheckpointRow): string | null {
    const rows = this.store.listCheckpoints(row.threadId, 50);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const candidate = rows[index]!;
      if (candidate.id === row.id || candidate.seq > row.seq) continue;
      if (candidate.status === "ok" && candidate.commit !== null && candidate.workspace === row.workspace) return candidate.commit;
    }
    return null;
  }

  private insert(input: {
    threadId: string;
    workspace: ResolvedWorkspace;
    kind: CheckpointKind;
    label: string | null;
    attempt: DispatchAttempt | null;
    eventMark: number | null;
    messageExcerpt: string | null;
  }): CheckpointRow {
    const row = this.store.insertCheckpoint({
      id: newId("ck", this.now()),
      threadId: input.threadId,
      projectId: input.workspace.projectId,
      environmentId: input.workspace.environmentId,
      hostId: input.workspace.hostId,
      workspace: input.workspace.path,
      kind: input.kind,
      label: input.label,
      attempt: input.attempt,
      eventMark: input.eventMark,
      messageExcerpt: input.messageExcerpt,
      createdAt: this.now(),
    });
    this.deps.publish(input.threadId);
    return row;
  }

  // ----------------------------------------------------------- the gate

  /**
   * The before-turn checkpoint. bb's hook runs under a server-wide lock, so
   * the gate holds a message at most `gateHoldMs`. A slower snapshot queues
   * the message ("wait") and releases it with `recheck` once the checkpoint
   * is saved, so the checkpoint is exact rather than late. A message Rewind
   * queued is never queued again for a snapshot: its re-attempt proceeds,
   * whoever triggered it. While a restore writes the environment, messages
   * queue until it ends. Never throws; every failure proceeds.
   */
  async onDispatch(ctx: MessageDispatchHookContext): Promise<GateResult> {
    const started = this.now();
    let decision: MessageDispatchHookDecision = PROCEED;
    let outcome = "skipped";
    let checkpointId: string | null = null;
    let snapshotMs: number | null = null;
    try {
      const settings = this.deps.settings();
      const environment = ctx.environment;
      const ours = this.ourRows(ctx.queuedMessages);
      const wait = ours.length > 0 ? this.waitForRows(ctx.thread.id, ours) : null;
      // The re-attempt that measures recheck latency is the first one after
      // Rewind's recheck; bb may also re-attempt a row on its own before that.
      if (wait !== null && (wait.reattemptAt === null || (wait.recheckAt !== null && wait.reattemptAt < wait.recheckAt))) {
        this.updateWait(wait, { reattemptAt: started });
      }

      if (environment !== null && this.isRestoring(environment.id)) {
        // A restore is writing these files: hold every message until it ends,
        // with automatic checkpoints on or off. The cap is a safety net only.
        const since = wait?.kind === "restore" ? wait.createdAt : started;
        if (started - since < RESTORE_TIMEOUT_MS) {
          if (wait?.kind !== "restore") {
            const opened = this.openWait(ctx.thread.id, environment.id, "restore", null, ours, started);
            this.waitExcerpts.set(opened.id, excerpt(ctx.input.text));
          }
          return this.finishGate(ctx, started, { action: "wait", reason: WAIT_REASON_RESTORE, sendAt: since + RESTORE_TIMEOUT_MS }, "wait:restore", null, null);
        }
        this.noteRestoreCapRelease(environment.id, ctx.thread);
        outcome = "released:restore-cap";
      } else if (!settings.enabled) {
        outcome = "skipped:disabled";
      } else if (environment === null) {
        outcome = "skipped:no-environment";
      } else if (isProjectExcluded(settings, ctx.project)) {
        outcome = "skipped:excluded-project";
      } else if (environment.status !== "ready" || environment.path === null) {
        outcome = "skipped:environment-not-ready";
      } else if (ctx.attempt === "start-turn" && RUNNING_STATUSES.has(ctx.thread.status)) {
        // Queued behind the running turn; the drain re-attempt snapshots.
        outcome = "skipped:queued";
      } else {
        const joinTurn = ctx.attempt === "join-turn";
        const workspace: ResolvedWorkspace = {
          environmentId: environment.id,
          hostId: environment.hostId,
          path: environment.path,
          isGit: environment.isGitRepo,
          projectId: ctx.project.id,
        };
        let row = this.gateCheckpoint(wait);
        if (row !== null) {
          outcome = "reused";
        } else {
          const mark = await this.withDeadline(this.eventMark(ctx.thread.id), MARK_WAIT_MS, null);
          const latest = this.store.listCheckpoints(ctx.thread.id, 1).at(-1);
          if (
            latest !== undefined &&
            latest.kind === "before-turn" &&
            mark !== null &&
            latest.eventMark === mark &&
            (latest.status === "ok" || latest.status === "pending")
          ) {
            // The same dispatch asked again (another plugin made it wait).
            row = latest;
            outcome = "reused";
          } else {
            row = this.insert({
              threadId: ctx.thread.id,
              workspace,
              kind: "before-turn",
              label: null,
              attempt: ctx.attempt,
              eventMark: mark,
              messageExcerpt: excerpt(ctx.input.text),
            });
            const snapshotStarted = this.now();
            const job = this.track(
              this.runSnapshot(row).then((done) => {
                snapshotMs = this.now() - snapshotStarted;
                this.store.setGateSnapshotMs(done.id, snapshotMs);
                return done;
              }),
            );
            this.jobs.set(row.id, job);
            void job.finally(() => this.jobs.delete(row!.id)).catch(() => undefined);
            outcome = "ok";
          }
        }
        checkpointId = row.id;
        const job = this.jobs.get(row.id);
        if (job !== undefined) {
          if (joinTurn) {
            // A steer joins a running turn: the agent is already writing, so
            // holding it would not make the snapshot cleaner.
            outcome = "background:join-turn";
          } else if (wait !== null && wait.checkpointId === row.id) {
            // Re-attempted while its checkpoint is still being saved: decide at
            // once, holding nothing. bb re-attempts queued rows on its own
            // schedule (seen live: 2.8 s after a re-queue) and every recheck
            // wakes every row, so the message stays in its one wait, with its
            // first deadline, until the checkpoint is saved. It is never
            // queued twice: past the deadline it goes, and Send now skips this.
            if (started < wait.createdAt + GATE_WAIT_CAP_MS - 1_000) {
              return this.finishGate(ctx, started, { action: "wait", reason: WAIT_REASON_SNAPSHOT, sendAt: wait.createdAt + GATE_WAIT_CAP_MS }, "wait:still-saving", row.id, null);
            }
            this.released.set(row.id, this.now());
            outcome = "released:pending";
          } else {
            const finished = await this.withDeadline(job, Math.max(0, started + settings.gateHoldMs - this.now()), null);
            if (finished !== null) {
              outcome = finished.status === "ok" ? outcome : `failed:${finished.status}`;
            } else if (wait !== null) {
              // Queued once already: go now, and let the checkpoint finish
              // behind the message (late only if it really finishes after).
              this.released.set(row.id, this.now());
              outcome = "released:pending";
            } else {
              this.openWait(ctx.thread.id, environment.id, "snapshot", row.id, ours, started);
              void job.then(
                () => this.releaseWaits((candidate) => candidate.checkpointId === row!.id, "snapshot saved"),
                () => this.releaseWaits((candidate) => candidate.checkpointId === row!.id, "snapshot failed"),
              );
              return this.finishGate(ctx, started, { action: "wait", reason: WAIT_REASON_SNAPSHOT, sendAt: started + GATE_WAIT_CAP_MS }, "wait:snapshot", row.id, null);
            }
          }
        } else if (row.status === "pending") {
          // Its snapshot belongs to an earlier load of the plugin and will
          // never report back; the message goes now.
          outcome = "released:orphaned";
        }
      }
    } catch (error) {
      outcome = "error";
      decision = PROCEED;
      this.deps.log.warn(`dispatch gate failed open: ${errorText(error)}`);
    }
    return this.finishGate(ctx, started, decision, outcome, checkpointId, snapshotMs);
  }

  private finishGate(
    ctx: MessageDispatchHookContext,
    started: number,
    decision: MessageDispatchHookDecision,
    outcome: string,
    checkpointId: string | null,
    snapshotMs: number | null,
  ): GateResult {
    const heldMs = this.now() - started;
    try {
      this.store.recordGate({
        threadId: ctx.thread.id,
        checkpointId,
        outcome,
        decision: decision.action === "wait" ? "wait" : "proceed",
        waitedMs: heldMs,
        snapshotMs,
        createdAt: started,
      });
    } catch {
      // Stats are best effort.
    }
    if (decision.action === "proceed" && ctx.attempt === "start-turn" && ctx.initiator === "user") {
      // The user sent their next message: a pending restore note is moot.
      if (this.store.deleteNote(ctx.thread.id)) this.deps.publish(ctx.thread.id);
    }
    return { decision, outcome, checkpointId, heldMs };
  }

  /** The before-turn checkpoint a queued message is waiting for, if still usable. */
  private gateCheckpoint(wait: GateWaitRow | null): CheckpointRow | null {
    if (wait === null || wait.checkpointId === null) return null;
    const row = this.store.getCheckpoint(wait.checkpointId);
    return row !== null && (row.status === "ok" || row.status === "pending") ? row : null;
  }

  // ------------------------------------------------------------ waits

  /** Rows this attempt re-tries that Rewind queued. */
  private ourRows(rows: readonly QueuedRow[]): QueuedRow[] {
    return rows.filter((row) => this.waitByRow.has(row.id) || isRewindWait(row.waitingOn));
  }

  /** The wait these rows belong to; one is rebuilt for rows queued before a restart. */
  private waitForRows(threadId: string, rows: readonly QueuedRow[]): GateWaitRow {
    for (const row of rows) {
      const known = this.waitByRow.get(row.id);
      if (known !== undefined) return known;
    }
    const open = this.waitsByThread.get(threadId);
    if (open !== undefined) {
      this.updateWait(open, { rowIds: [...new Set([...open.rowIds, ...rows.map((row) => row.id)])] });
      return open;
    }
    const reason = rows.map((row) => (row.waitingOn?.kind === "plugin" ? row.waitingOn.reason : "")).join(" ");
    const kind: GateWaitKind = reason.includes(WAIT_REASON_RESTORE) ? "restore" : "snapshot";
    const createdAt = Math.min(...rows.map((row) => row.createdAt));
    return this.openWait(threadId, null, kind, null, rows, createdAt);
  }

  private openWait(threadId: string, environmentId: string | null, kind: GateWaitKind, checkpointId: string | null, rows: readonly QueuedRow[], createdAt: number): GateWaitRow {
    const previous = this.waitsByThread.get(threadId);
    const rowIds = [...new Set([...(previous?.rowIds ?? []), ...rows.map((row) => row.id)])];
    if (previous !== undefined) this.closeWait(previous, "superseded");
    const wait = this.store.insertGateWait({ id: newId("gw", this.now()), threadId, environmentId, kind, checkpointId, rowIds, createdAt });
    this.indexWait(wait);
    return wait;
  }

  private indexWait(wait: GateWaitRow): void {
    this.waitsByThread.set(wait.threadId, wait);
    for (const rowId of wait.rowIds) this.waitByRow.set(rowId, wait);
  }

  private updateWait(wait: GateWaitRow, fields: Partial<Pick<GateWaitRow, "checkpointId" | "rowIds" | "recheckAt" | "reattemptAt" | "dispatchedAt">>): void {
    Object.assign(wait, fields);
    if (fields.rowIds !== undefined) for (const rowId of fields.rowIds) this.waitByRow.set(rowId, wait);
    try {
      this.store.updateGateWait(wait.id, fields);
    } catch (error) {
      this.deps.log.warn(`could not record wait ${wait.id}: ${errorText(error)}`);
    }
  }

  private closeWait(wait: GateWaitRow, by: string): void {
    this.waitExcerpts.delete(wait.id);
    const closedAt = this.now();
    wait.closedAt = closedAt;
    wait.closedBy = by;
    if (this.waitsByThread.get(wait.threadId) === wait) this.waitsByThread.delete(wait.threadId);
    for (const rowId of wait.rowIds) if (this.waitByRow.get(rowId) === wait) this.waitByRow.delete(rowId);
    try {
      this.store.updateGateWait(wait.id, { closedAt, closedBy: by });
    } catch {
      // Bookkeeping only.
    }
  }

  /** Waits a previous load left open: keep recent ones so their re-attempt proceeds. */
  private loadWaits(): void {
    let open: GateWaitRow[] = [];
    try {
      open = this.store.openGateWaits();
    } catch {
      return;
    }
    const now = this.now();
    for (const wait of open) {
      if (now - wait.createdAt > STALE_WAIT_MS) this.closeWait(wait, "stale");
      else this.indexWait(wait);
    }
  }

  /** Ask core to re-attempt the queued messages whose wait matches. */
  private releaseWaits(matches: (wait: GateWaitRow) => boolean, why: string): void {
    if (this.disposed) return;
    const waits = [...this.waitsByThread.values()].filter((wait) => wait.closedAt === null && wait.dispatchedAt === null && matches(wait));
    if (waits.length === 0) return;
    const at = this.now();
    for (const wait of waits) if (wait.recheckAt === null) this.updateWait(wait, { recheckAt: at });
    this.deps.log.debug(`recheck (${why}) for ${waits.map((wait) => wait.threadId).join(", ")}`);
    void (this.deps.recheck?.() ?? Promise.resolve()).catch((error: unknown) => {
      this.deps.log.warn(`could not ask bb to re-send queued messages (${why}): ${errorText(error)}`);
    });
  }

  /** `message.queued`: learn the id of a row a Rewind wait created. */
  onMessageQueued(entry: QueuedRow): void {
    if (!isRewindWait(entry.waitingOn) || this.waitByRow.has(entry.id)) return;
    const wait = this.waitsByThread.get(entry.threadId);
    if (wait !== undefined) this.updateWait(wait, { rowIds: [...new Set([...wait.rowIds, entry.id])] });
  }

  /**
   * `message.dispatched`: a row Rewind queued went out — by its re-attempt,
   * or by the user's Send now, which skips the hook. A checkpoint still
   * running then is late.
   */
  onMessageDispatched(entry: QueuedRow): void {
    const wait = this.waitByRow.get(entry.id);
    if (wait === undefined) return;
    const at = this.now();
    this.updateWait(wait, { dispatchedAt: at });
    if (wait.checkpointId !== null && this.jobs.has(wait.checkpointId) && !this.released.has(wait.checkpointId)) {
      this.released.set(wait.checkpointId, at);
    }
    this.closeWait(wait, wait.reattemptAt === null ? "send-now" : "dispatched");
  }

  /** `message.cancelled`: the user deleted a row Rewind queued. */
  onMessageCancelled(entry: QueuedRow): void {
    const wait = this.waitByRow.get(entry.id);
    if (wait !== undefined) this.closeWait(wait, "cancelled");
  }

  private isRestoring(environmentId: string): boolean {
    return (this.restoring.get(environmentId) ?? 0) > 0;
  }

  private noteRestoreCapRelease(environmentId: string, thread: { id: string; title?: string | null }): void {
    const name = thread.title ?? thread.id;
    this.deps.log.warn(`released a message to ${name} after ${RESTORE_TIMEOUT_MS / 60_000} minutes while a restore was still writing its files`);
    const list = this.restoreCapReleases.get(environmentId) ?? [];
    list.push(name);
    this.restoreCapReleases.set(environmentId, list);
  }

  private async withDeadline<T, F>(work: Promise<T>, ms: number, fallback: F): Promise<T | F> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<F>((resolve) => {
      timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * bb's storage directory for the thread, for the host to leave alone when it
   * lies inside the workspace. Best effort and brief: snapshots run while the
   * gate holds a message, so a slow lookup finishes in the background.
   */
  private async excludePaths(threadId: string, hostId: string): Promise<string[] | undefined> {
    let root = this.storageRoots.get(threadId) ?? null;
    if (root === null) {
      const missed = this.storageMisses.get(threadId);
      if (missed !== undefined && this.now() - missed < STORAGE_RETRY_MS) return undefined;
      let lookup = this.storageLookups.get(threadId);
      if (lookup === undefined) {
        lookup = Promise.resolve()
          .then(() => this.sdk.threads.storageLocation({ threadId }))
          .then((location) => (absolutePathSchema.safeParse(location.storageRootPath).success ? { hostId: location.hostId, path: location.storageRootPath } : null))
          .catch(() => null)
          .then((found) => {
            this.storageLookups.delete(threadId);
            if (found === null) this.storageMisses.set(threadId, this.now());
            else this.storageRoots.set(threadId, found);
            return found;
          });
        this.storageLookups.set(threadId, lookup);
      }
      root = await this.withDeadline(lookup, STORAGE_LOOKUP_MS, null);
    }
    return root !== null && root.hostId === hostId ? [root.path] : undefined;
  }

  // ------------------------------------------------ lifecycle snapshots

  private automatic(project: { id: string } | null): boolean {
    const settings = this.deps.settings();
    return settings.enabled && !isProjectExcluded(settings, project);
  }

  private async projectOf(projectId: string): Promise<{ id: string; name: string } | null> {
    try {
      const project = await this.sdk.projects.get({ projectId });
      return { id: project.id, name: project.name };
    } catch {
      return { id: projectId, name: "" };
    }
  }

  /**
   * The start of a new thread's event log (oldest first). A thread becomes
   * active a few dozen events in, so one page covers what the baseline needs.
   */
  private async earlyEvents(threadId: string): Promise<Array<{ type: string; data: unknown }> | null> {
    try {
      return await this.sdk.threads.events.list({ threadId, order: "asc", limit: "100" });
    } catch (error) {
      this.deps.log.warn(`could not read the event log of ${threadId}: ${errorText(error)}`);
      return null;
    }
  }

  /** Did the agent start anything that may touch files? */
  private static agentActed(events: ReadonlyArray<{ type: string; data: unknown }>): boolean {
    return events.some((event) => {
      if (event.type !== "item/started") return false;
      const item = (event.data as { item?: { type?: unknown } } | null)?.item;
      return typeof item?.type === "string" && !PASSIVE_ITEM_TYPES.has(item.type);
    });
  }

  /**
   * A brand-new thread's first message dispatches before its environment
   * exists, so its baseline is taken as soon as the thread becomes active.
   */
  async onThreadActive(thread: { id: string; projectId: string; environmentId: string | null }): Promise<CheckpointRow | null> {
    if (this.disposed || thread.environmentId === null) return null;
    if (!this.automatic(await this.projectOf(thread.projectId))) return null;
    if (this.store.hasCheckpoints(thread.id)) return null;
    const early = await this.earlyEvents(thread.id);
    // Not the first turn (or a long history): the gate covers later messages.
    if (early === null || early.length >= 100 || early.filter((event) => event.type === "turn/started").length > 1) return null;
    let workspace: ResolvedWorkspace;
    try {
      workspace = (await this.resolveWorkspace(thread.id)).workspace;
    } catch {
      return null;
    }
    const actedBefore = RewindService.agentActed(early);
    const row = this.insert({
      threadId: thread.id,
      workspace,
      kind: "before-turn",
      label: "Thread start",
      attempt: "start-turn",
      // Before every message of the thread.
      eventMark: 0,
      messageExcerpt: null,
    });
    const done = await this.runSnapshot(row);
    // Taken after the agent started: flag it when a tool may already have run.
    const after = done.status === "ok" && !actedBefore ? await this.earlyEvents(thread.id) : null;
    if (done.status === "ok" && (actedBefore || (after !== null && RewindService.agentActed(after)))) {
      this.store.markLate(done.id);
      this.deps.publish(thread.id);
      return this.store.getCheckpoint(done.id);
    }
    return done;
  }

  /** The after-turn checkpoint, when a turn ends (idle or failed). */
  async onTurnEnded(thread: { id: string; projectId: string; environmentId: string | null }): Promise<CheckpointRow | null> {
    if (this.disposed || thread.environmentId === null) return null;
    if (!this.automatic(await this.projectOf(thread.projectId))) return null;
    let resolved: { thread: ThreadDto; workspace: ResolvedWorkspace };
    try {
      resolved = await this.resolveWorkspace(thread.id);
    } catch {
      return null;
    }
    let mark: number | null;
    let late = false;
    if (RUNNING_STATUSES.has(resolved.thread.status)) {
      // The next turn already started. A message sent through bb passed the
      // gate, whose before-turn checkpoint holds these files. A turn the
      // provider started on its own (a wakeup, a finished background task)
      // did not: capture at the end of this turn, flagged late because the
      // new turn may already have changed files.
      const ended = await this.lastTurnEnd(thread.id);
      if (ended === null) return null;
      const covered = this.store
        .listCheckpoints(thread.id, 10)
        .some(
          (row) =>
            row.kind === "before-turn" &&
            row.attempt === "start-turn" &&
            row.eventMark !== null &&
            row.eventMark >= ended &&
            (row.status === "ok" || row.status === "pending"),
        );
      if (covered) return null;
      mark = ended;
      late = true;
    } else {
      mark = await this.eventMark(thread.id);
    }
    const latest = this.store.listCheckpoints(thread.id, 1).at(-1);
    // Nothing happened in the thread since its latest checkpoint (an idle
    // fork, a repeated idle event): there is no turn to capture.
    if (latest !== undefined && mark !== null && latest.eventMark === mark && (latest.status === "ok" || latest.status === "pending")) return latest;
    // A queued message dispatched the moment the turn ended: its before-turn
    // checkpoint already holds these files.
    if (latest !== undefined && latest.kind === "before-turn" && latest.attempt === "start-turn" && mark !== null && latest.eventMark !== null && latest.eventMark >= mark) {
      return latest;
    }
    const row = this.insert({
      threadId: thread.id,
      workspace: resolved.workspace,
      kind: "after-turn",
      label: null,
      attempt: null,
      eventMark: mark,
      messageExcerpt: null,
    });
    const done = await this.runSnapshot(row);
    if (!late || done.status !== "ok") return done;
    this.store.markLate(done.id);
    this.deps.publish(thread.id);
    return this.store.getCheckpoint(done.id);
  }

  /** The seq of the latest turn/completed event among the last 100, if any. */
  private async lastTurnEnd(threadId: string): Promise<number | null> {
    try {
      const rows = await this.sdk.threads.events.list({ threadId, order: "desc", limit: "100" });
      const ended = rows.find((row) => row.type === "turn/completed");
      return typeof ended?.seq === "number" ? ended.seq : null;
    } catch (error) {
      this.deps.log.warn(`could not read the event log of ${threadId}: ${errorText(error)}`);
      return null;
    }
  }

  async onThreadDeleted(threadId: string): Promise<number> {
    const deleted = this.store.deleteThread(threadId);
    await this.deleteRefs(deleted);
    this.deps.publish(threadId);
    return deleted.length;
  }

  private async deleteRefs(deleted: ReadonlyArray<{ id: string; hostId: string; workspace: string }>): Promise<void> {
    const groups = new Map<string, { hostId: string; workspace: string; ids: string[] }>();
    for (const entry of deleted) {
      const key = `${entry.hostId}\u0000${entry.workspace}`;
      const group = groups.get(key) ?? { hostId: entry.hostId, workspace: entry.workspace, ids: [] };
      group.ids.push(entry.id);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      try {
        await this.deps.host.call("deleteRefs", { workspace: group.workspace, checkpointIds: group.ids }, { hostId: group.hostId, timeoutMs: 60_000 });
      } catch (error) {
        // Host offline: the daily reconcile drops the refs later.
        this.deps.log.info(`could not delete ${group.ids.length} refs on ${group.hostId} now: ${errorText(error)}`);
      }
    }
  }

  // ------------------------------------------------------------- manual

  async checkpointNow(threadId: string, label: string | null): Promise<CheckpointRow> {
    const { workspace } = await this.resolveWorkspace(threadId);
    const row = this.insert({
      threadId,
      workspace,
      kind: "manual",
      label: label === null || label.trim().length === 0 ? null : label.trim().slice(0, 200),
      attempt: null,
      eventMark: await this.eventMark(threadId),
      messageExcerpt: null,
    });
    const done = await this.runSnapshot(row, { force: true });
    if (done.status !== "ok") {
      throw new RewindError(
        done.status === "unsupported" ? "workspace_unsupported" : "checkpoint_failed",
        `The checkpoint could not be taken: ${done.error ?? done.status}`,
      );
    }
    return done;
  }

  // ------------------------------------------------------------ reading

  summary(threadId: string) {
    const counts = this.store.countCheckpoints(threadId);
    return { enabled: this.deps.settings().enabled, count: counts.total, pending: counts.pending, lastCheckpointAt: counts.lastAt };
  }

  async list(threadId: string, limit = 500) {
    const settings = this.deps.settings();
    const rows = this.store.listCheckpoints(threadId, limit);
    this.fillEffects(rows);
    const checkpoints = rows.map(toCheckpointDto);
    const restores = this.store.listRestores(threadId).map(toRestoreDto);
    let workspace: WorkspaceInfo | null = null;
    let workspaceError: string | null = null;
    let projectExcluded = false;
    try {
      const resolved = await this.resolveWorkspace(threadId);
      workspace = await this.workspaceInfo(threadId, resolved.workspace);
      projectExcluded = isProjectExcluded(settings, await this.projectOf(resolved.thread.projectId));
    } catch (error) {
      workspaceError = errorText(error);
    }
    return { threadId, checkpoints, restores, workspace, workspaceError, settings: this.settingsDto(projectExcluded) };
  }

  settingsDto(projectExcluded = false) {
    const settings = this.deps.settings();
    return {
      enabled: settings.enabled,
      gateHoldMs: settings.gateHoldMs,
      maxFileSizeMB: Math.round((settings.maxFileBytes / 1024 / 1024) * 100) / 100,
      maxCheckpointsPerThread: settings.maxCheckpointsPerThread,
      retentionDays: settings.retentionDays,
      projectExcluded,
    };
  }

  async resolveMessage(threadId: string, message: { threadId?: string | undefined; role: "user" | "assistant"; sourceSeqEnd: number }) {
    // A message a fork inherited belongs to its source thread's history.
    const owner = message.threadId !== undefined && message.threadId.startsWith("thr_") ? message.threadId : threadId;
    const checkpoints = this.store.listCheckpoints(owner);
    // Restores live in their own table; order them by the pre-restore
    // checkpoint each one took, which sits in the checkpoint sequence.
    const restores = this.store.listRestores(owner).flatMap((restore) => {
      const pre = restore.preRestoreCheckpointId === null ? null : this.store.getCheckpoint(restore.preRestoreCheckpointId);
      return pre === null ? [] : [{ ...restore, seq: pre.seq + 0.5 }];
    });
    let turnRunning = false;
    if (message.role === "assistant") {
      try {
        turnRunning = RUNNING_STATUSES.has((await this.getThread(owner)).status);
      } catch {
        turnRunning = false;
      }
    }
    const result = resolveMessageCheckpoint(checkpoints, restores, message, { turnRunning });
    const checkpoint = result.checkpointId === null ? null : this.store.getCheckpoint(result.checkpointId);
    this.deps.log.debug(`resolveMessage ${owner} ${message.role}@${message.sourceSeqEnd} -> ${result.match} ${result.checkpointId ?? "none"}`);
    let info: { number: number | null; text: string; editable: boolean } | null = null;
    if (message.role === "user" && owner === threadId) {
      // Only this thread's own turn-starting messages can be edited, and only
      // when its provider can replace a message.
      const messages = await this.userMessages(threadId).catch((error: unknown) => {
        this.deps.log.info(`could not read the timeline of ${threadId}: ${errorText(error)}`);
        return [];
      });
      const found = messages.find((candidate) => candidate.sourceSeqEnd === message.sourceSeqEnd);
      if (found !== undefined) info = { number: found.number, text: found.text, editable: found.fromUser && (await this.canEditMessages(threadId)) };
    }
    return {
      match: checkpoint === null ? ("none" as const) : result.match,
      checkpoint: checkpoint === null ? null : toCheckpointDto(checkpoint),
      note: checkpoint === null && result.checkpointId !== null ? "The checkpoint was deleted by retention." : result.note,
      message: info,
    };
  }

  async diff(input: { threadId: string; from: string; to: string; paths?: string[] | undefined; patch?: boolean | undefined }) {
    const resolved = await this.resolveWorkspace(input.threadId).catch(() => null);
    const revision = (id: string): Revision => {
      if (id === "empty") return { kind: "empty" };
      if (id === "current") return { kind: "workspace" };
      const checkpoint = this.requireCheckpoint(id);
      return { kind: "checkpoint", commit: checkpoint.commit!, checkpointId: checkpoint.id };
    };
    const from = revision(input.from);
    const to = revision(input.to);
    // Diffs run in the shadow that holds the checkpoints.
    const anchor = [input.from, input.to].map((id) => this.store.getCheckpoint(id)).find((row) => row !== null) ?? null;
    const hostId = anchor?.hostId ?? resolved?.workspace.hostId;
    const workspace = anchor?.workspace ?? resolved?.workspace.path;
    if (hostId === undefined || workspace === undefined) throw new RewindError("no_environment", "Nothing to compare: the thread has no workspace.");
    if ((to.kind === "workspace" || from.kind === "workspace") && (resolved === null || resolved.workspace.path !== workspace || resolved.workspace.hostId !== hostId)) {
      throw new RewindError("different_workspace", "That checkpoint belongs to another workspace; compare it with checkpoints instead of the current files.");
    }
    const result = await this.deps.host.call(
      "diff",
      {
        workspace,
        from,
        to,
        paths: input.paths ?? null,
        patch: input.patch === true,
        maxFiles: input.patch === true ? 200 : 2_000,
        maxPatchBytesPerFile: MAX_PATCH_BYTES_PER_FILE,
        maxPatchBytesTotal: MAX_PATCH_BYTES_TOTAL,
        limits: this.limits(),
        excludePaths: await this.excludePaths(input.threadId, hostId),
      },
      { hostId, timeoutMs: DIFF_TIMEOUT_MS },
    );
    if (result.status !== "ok") throw new RewindError(`diff_${result.status}`, result.reason);
    return { files: result.files, totalFiles: result.totalFiles, filesTruncated: result.filesTruncated, stats: result.stats };
  }

  // ------------------------------------------------------------ restore

  async preview(threadId: string, checkpointId: string) {
    const checkpoint = this.requireCheckpoint(checkpointId);
    const { workspace } = await this.resolveWorkspace(threadId);
    const sourceWorkspace = this.sourceFor(checkpoint, workspace);
    const result = await this.deps.host.call(
      "restore",
      {
        workspace: workspace.path,
        target: { commit: checkpoint.commit!, checkpointId: checkpoint.id, sourceWorkspace },
        dryRun: true,
        preRestore: null,
        limits: this.limits(),
        excludePaths: await this.excludePaths(threadId, workspace.hostId),
        maxListed: 500,
      },
      { hostId: workspace.hostId, timeoutMs: RESTORE_TIMEOUT_MS },
    );
    if (result.status !== "ok") throw new RewindError(`restore_${result.status}`, result.reason);
    const checkpointHead = checkpoint.head?.sha ?? null;
    const currentHead = result.head?.sha ?? null;
    return {
      checkpoint: toCheckpointDto(checkpoint),
      plan: result.plan,
      skipped: result.skipped,
      skippedCount: result.skippedCount,
      currentHead: result.head,
      headMoved: checkpointHead !== null && currentHead !== null && checkpointHead !== currentHead,
      workspace: await this.workspaceInfo(threadId, workspace),
      effects: await this.effectsAfter(threadId, checkpoint),
    };
  }

  async restore(threadId: string, checkpointId: string, kind: RestoreKind = "restore", options: { note?: boolean } = {}): Promise<RestoreOutcome> {
    const checkpoint = this.requireCheckpoint(checkpointId);
    const { workspace } = await this.resolveWorkspace(threadId);
    const sourceWorkspace = this.sourceFor(checkpoint, workspace);
    // Messages to this environment queue from here on, so none can start a
    // turn between the running check and the end of the restore.
    this.beginRestore(workspace.environmentId);
    let outcome: RestoreOutcome;
    try {
      const running = await this.runningThreads(workspace.environmentId, threadId);
      if (running.length > 0) {
        const names = running.map((thread) => `${thread.isSelf ? "this thread" : (thread.title ?? thread.id)} (${thread.id}, ${thread.status})`).join(", ");
        throw new RewindError(
          "thread_running",
          `Not restoring while ${running.length === 1 ? "a thread is" : "threads are"} running in this workspace: ${names}. A running agent could overwrite the restored files or act on files that changed under it.`,
          `Stop ${running.length === 1 ? "it" : "them"} first (${running.map((thread) => `\`bb thread stop ${thread.id}\``).join(", ")}), or rerun with --stop-running.`,
        );
      }
      outcome = await this.applyRestore(threadId, workspace, checkpoint, sourceWorkspace, kind);
    } finally {
      this.endRestore(workspace.environmentId);
    }
    if (kind === "undo") {
      // Back to the files the conversation was built on: nothing to explain.
      if (this.store.deleteNote(threadId)) this.deps.publish(threadId);
    } else {
      outcome = { ...outcome, effects: await this.effectsAfter(threadId, checkpoint) };
      if (options.note !== false) outcome = { ...outcome, note: await this.recordNote(threadId, outcome.restore.id, checkpoint) };
    }
    return outcome;
  }

  // ------------------------------------------------------ effects

  /**
   * Commands started in (fromMark, toMark] whose effects reach outside the
   * workspace, one per label. Reads command-start events only, bounded.
   */
  private async scanEffects(threadId: string, workspace: string, fromMark: number, toMark: number): Promise<StoredEffect[]> {
    const effects: StoredEffect[] = [];
    const labels = new Set<string>();
    let after = fromMark;
    for (let page = 0; page < EFFECT_PAGES && after < toMark; page += 1) {
      const rows = await this.commandStarts(threadId, after, toMark);
      for (const row of rows) {
        const item = (row.data as { item?: { type?: unknown; command?: unknown; cwd?: unknown } } | null)?.item;
        if (item?.type !== "commandExecution" || typeof item.command !== "string") continue;
        for (const effect of detectEffects(item.command, { workspace, cwd: typeof item.cwd === "string" ? item.cwd : null })) {
          if (labels.has(effect.label)) continue;
          labels.add(effect.label);
          effects.push({ kind: effect.kind, label: effect.label, command: effect.command });
        }
      }
      if (rows.length < EFFECT_PAGE) break;
      after = rows.at(-1)!.seq;
    }
    return effects.slice(0, MAX_EFFECTS_PER_RANGE);
  }

  private async commandStarts(threadId: string, afterSeq: number, toSeq: number): Promise<Array<{ seq: number; type: string; data: unknown }>> {
    const range = { threadId, afterSeq: String(afterSeq), beforeSeq: String(toSeq + 1), order: "asc" as const, limit: String(EFFECT_PAGE) };
    try {
      return await this.sdk.threads.events.list({ ...range, types: ["item/started"] });
    } catch (error) {
      // A server that rejects the type filter still pages the range.
      this.deps.log.debug(`event type filter failed (${errorText(error)}); filtering locally`);
      return (await this.sdk.threads.events.list(range)).filter((row) => row.type === "item/started");
    }
  }

  /** A checkpoint's effects: the commands since the thread's previous checkpoint. */
  private ensureEffects(row: CheckpointRow): Promise<StoredEffect[]> {
    if (row.effects !== null) return Promise.resolve(row.effects);
    const running = this.scans.get(row.id);
    if (running !== undefined) return running;
    const scan = this.scanCheckpoint(row).finally(() => this.scans.delete(row.id));
    this.scans.set(row.id, scan);
    return scan;
  }

  private async scanCheckpoint(row: CheckpointRow): Promise<StoredEffect[]> {
    if (row.eventMark === null) return [];
    const mark = row.eventMark;
    const previous = this.store
      .listCheckpoints(row.threadId)
      .filter((candidate) => candidate.seq < row.seq && candidate.eventMark !== null)
      .reduce((max, candidate) => Math.max(max, candidate.eventMark!), 0);
    const effects = mark > previous ? await this.scanEffects(row.threadId, row.workspace, previous, mark) : [];
    this.store.setEffects(row.id, effects);
    if (effects.length > 0) this.deps.publish(row.threadId);
    return effects;
  }

  /** Scan, in the background, the ranges of checkpoints listed before this feature existed. */
  private fillEffects(rows: readonly CheckpointRow[]): void {
    const missing = rows.filter((row) => row.effects === null && row.eventMark !== null && row.status !== "pending").slice(-EFFECT_ROWS_INLINE);
    if (missing.length === 0 || this.disposed) return;
    void this.track(
      (async () => {
        for (const row of missing) await this.ensureEffects(row).catch(() => undefined);
      })(),
    );
  }

  /**
   * Commands with effects outside the workspace in every turn after `target`,
   * which a restore to it undoes on disk but cannot undo out there.
   */
  async effectsAfter(threadId: string, target: CheckpointRow): Promise<UndoneEffect[]> {
    if (target.threadId !== threadId || target.eventMark === null) return [];
    try {
      const rows = this.store.listCheckpoints(threadId);
      const turnOf = new Map<string, number | null>();
      for (const group of groupTurns(rows)) {
        for (const member of [group.before, group.after, ...group.extras]) if (member !== null) turnOf.set(member.id, group.turn);
      }
      const later = rows.filter((row) => row.seq > target.seq && row.eventMark !== null && row.status !== "pending");
      const out: UndoneEffect[] = [];
      for (const row of later.slice(-EFFECT_ROWS_INLINE)) {
        for (const effect of await this.ensureEffects(row)) out.push({ ...effect, turn: turnOf.get(row.id) ?? null });
      }
      // And whatever ran since the latest checkpoint.
      const lastMark = later.reduce((max, row) => Math.max(max, row.eventMark!), target.eventMark);
      const mark = await this.eventMark(threadId);
      if (mark !== null && mark > lastMark) {
        for (const effect of await this.scanEffects(threadId, target.workspace, lastMark, mark)) out.push({ ...effect, turn: null });
      }
      const seen = new Set<string>();
      return out.filter((effect) => {
        const key = `${effect.turn ?? "latest"}\u0000${effect.label}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch (error) {
      this.deps.log.info(`could not scan ${threadId}'s commands: ${errorText(error)}`);
      return [];
    }
  }

  private beginRestore(environmentId: string): void {
    this.restoring.set(environmentId, (this.restoring.get(environmentId) ?? 0) + 1);
  }

  /**
   * The last restore of an environment ended: checkpoint the restored files
   * for each message it queued (so those checkpoints are exact), then release
   * the messages.
   */
  private endRestore(environmentId: string): void {
    const count = (this.restoring.get(environmentId) ?? 1) - 1;
    if (count > 0) {
      this.restoring.set(environmentId, count);
      return;
    }
    this.restoring.delete(environmentId);
    const held = (wait: GateWaitRow) => wait.kind === "restore" && wait.closedAt === null && (wait.environmentId === environmentId || wait.environmentId === null);
    const waits = [...this.waitsByThread.values()].filter(held);
    if (waits.length === 0) return;
    void this.track(
      (async () => {
        for (const wait of waits) await this.checkpointHeldMessage(wait).catch(() => undefined);
      })().finally(() => this.releaseWaits(held, "restore ended")),
    );
  }

  /** The before-turn checkpoint of a message a restore held, taken before it goes. */
  private async checkpointHeldMessage(wait: GateWaitRow): Promise<void> {
    if (!this.automatic(await this.projectOf((await this.getThread(wait.threadId)).projectId))) return;
    const { workspace } = await this.resolveWorkspace(wait.threadId);
    const row = this.insert({
      threadId: wait.threadId,
      workspace,
      kind: "before-turn",
      label: null,
      attempt: "start-turn",
      eventMark: await this.eventMark(wait.threadId),
      messageExcerpt: this.waitExcerpts.get(wait.id) ?? null,
    });
    this.updateWait(wait, { checkpointId: row.id });
    const job = this.runSnapshot(row);
    this.jobs.set(row.id, job);
    await job.finally(() => this.jobs.delete(row.id));
  }

  private undoPointFrom(pre: CheckpointRow, commit: string, tree: string, durationMs: number): CheckpointRow | null {
    return this.store.completeCheckpoint(
      pre.id,
      {
        commit,
        tree,
        deduped: false,
        head: null,
        baseline: false,
        stats: { files: 0, insertions: 0, deletions: 0 },
        changes: [],
        changesTruncated: false,
        skipped: [],
        skippedCount: 0,
        fileCount: 0,
        durationMs,
      },
      { late: false, completedAt: this.now() },
    );
  }

  private recordRestore(input: {
    id: string;
    threadId: string;
    workspace: ResolvedWorkspace;
    kind: RestoreKind;
    target: CheckpointRow;
    preRestoreCheckpointId: string | null;
    status: RestoreRow["status"];
    eventMark: number | null;
    summary: RestoreRow["summary"];
    error: string | null;
    createdAt: number;
  }): RestoreRow {
    return this.store.insertRestore({
      id: input.id,
      threadId: input.threadId,
      environmentId: input.workspace.environmentId,
      hostId: input.workspace.hostId,
      workspace: input.workspace.path,
      kind: input.kind,
      targetCheckpointId: input.target.id,
      preRestoreCheckpointId: input.preRestoreCheckpointId,
      status: input.status,
      eventMark: input.eventMark,
      summary: input.summary,
      error: input.error,
      createdAt: input.createdAt,
    });
  }

  private async applyRestore(
    threadId: string,
    workspace: ResolvedWorkspace,
    checkpoint: CheckpointRow,
    sourceWorkspace: string | null,
    kind: RestoreKind,
  ): Promise<RestoreOutcome> {
    const mark = await this.eventMark(threadId);
    const pre = this.insert({
      threadId,
      workspace,
      kind: "pre-restore",
      label: kind === "undo" ? `Before undoing a restore` : kind === "fork" ? "Fresh worktree before fork files" : `Before restoring ${checkpoint.id}`,
      attempt: null,
      eventMark: mark,
      messageExcerpt: null,
    });
    const restoreId = newId("rs", this.now());
    const started = this.now();
    const incompleteHint = "Undo it to put every file back as it was before the restore: `bb rewind undo --yes`, or Undo in the Checkpoints panel.";
    let result;
    try {
      result = await this.deps.host.call(
        "restore",
        {
          workspace: workspace.path,
          target: { commit: checkpoint.commit!, checkpointId: checkpoint.id, sourceWorkspace },
          dryRun: false,
          preRestore: { checkpointId: pre.id, subject: `pre-restore ${pre.id} (${threadId})` },
          limits: this.limits(),
          excludePaths: await this.excludePaths(threadId, workspace.hostId),
          maxListed: 500,
        },
        { hostId: workspace.hostId, timeoutMs: RESTORE_TIMEOUT_MS },
      );
    } catch (error) {
      // Lost in transit, timed out, or the worker died: files may have
      // changed if the undo point was already taken, so look for it.
      const ref = await this.deps.host
        .call("refCommit", { workspace: workspace.path, checkpointId: pre.id }, { hostId: workspace.hostId, timeoutMs: 30_000 })
        .catch(() => null);
      const undoPoint = ref !== null && ref.commit !== null && ref.tree !== null ? this.undoPointFrom(pre, ref.commit, ref.tree, this.now() - started) : null;
      if (undoPoint === null) {
        this.store.failCheckpoint(pre.id, "failed", errorText(error), { late: false, completedAt: this.now(), durationMs: this.now() - started });
      }
      this.recordRestore({
        id: restoreId,
        threadId,
        workspace,
        kind,
        target: checkpoint,
        preRestoreCheckpointId: undoPoint === null ? null : pre.id,
        status: "failed",
        eventMark: mark,
        summary: null,
        error: errorText(error),
        createdAt: started,
      });
      this.deps.publish(threadId);
      throw undoPoint === null
        ? new RewindError("restore_failed", `Nothing was restored: ${errorText(error)}`)
        : new RewindError("restore_incomplete", `The restore did not finish and some files may have changed: ${errorText(error)}`, incompleteHint);
    }
    if (result.status !== "ok" || result.preRestore === null) {
      const reason = result.status === "ok" ? "no pre-restore checkpoint was taken" : result.reason;
      this.store.failCheckpoint(pre.id, result.status === "unsupported" ? "unsupported" : "failed", reason, {
        late: false,
        completedAt: this.now(),
        durationMs: this.now() - started,
      });
      this.deps.publish(threadId);
      throw new RewindError(`restore_${result.status}`, `Nothing was restored: ${reason}`);
    }
    const preRow = this.store.completeCheckpoint(pre.id, { ...result.preRestore, baseline: result.preRestore.comparedTo === null }, { late: false, completedAt: this.now() });

    if (result.applyError !== null) {
      this.recordRestore({
        id: restoreId,
        threadId,
        workspace,
        kind,
        target: checkpoint,
        // Nothing to undo when it stopped before touching a file.
        preRestoreCheckpointId: result.applied ? pre.id : null,
        status: "failed",
        eventMark: mark,
        summary: null,
        error: result.applyError,
        createdAt: started,
      });
      this.deps.publish(threadId);
      throw result.applied
        ? new RewindError("restore_incomplete", `The restore did not finish and some files may have changed: ${result.applyError}`, incompleteHint)
        : new RewindError("restore_failed", `Nothing was restored: ${result.applyError}`);
    }

    const verification = result.verification;
    const restore = this.recordRestore({
      id: restoreId,
      threadId,
      workspace,
      kind,
      target: checkpoint,
      preRestoreCheckpointId: pre.id,
      status: verification?.ok === true ? "ok" : "unverified",
      eventMark: mark,
      summary: {
        creates: result.plan.creates,
        writes: result.plan.writes,
        deletes: result.plan.deletes,
        protectedCount: result.plan.protectedCount,
        verified: verification?.ok === true,
        mismatchCount: verification?.mismatchCount ?? 0,
        untouchedCount: verification?.untouchedCount ?? 0,
      },
      error: verification?.ok === false ? `Verification found ${verification.mismatchCount} mismatch(es)` : null,
      createdAt: started,
    });
    // Messages queue while the files are written, but Send now and turns an
    // agent starts by itself skip the queue: those are worth a warning.
    const warnings: string[] = [];
    const startedMeanwhile = await this.runningThreads(workspace.environmentId, threadId).catch(() => []);
    if (startedMeanwhile.length > 0) {
      warnings.push(
        `${startedMeanwhile.map((thread) => (thread.isSelf ? "This thread" : (thread.title ?? thread.id))).join(", ")} started a turn while the files were being restored; check its first edits.`,
      );
    }
    const capped = this.restoreCapReleases.get(workspace.environmentId);
    if (capped !== undefined) {
      this.restoreCapReleases.delete(workspace.environmentId);
      warnings.push(`The restore ran so long that a message to ${capped.join(", ")} was sent before it finished; check that turn's first edits.`);
    }
    this.deps.publish(threadId);
    return {
      restore: toRestoreDto(restore),
      preRestore: preRow === null ? null : toCheckpointDto(preRow),
      plan: result.plan,
      verification,
      warnings,
      effects: [],
      note: null,
    };
  }

  // ------------------------------------------------ conversation sync

  /**
   * The thread's turn-starting user messages, oldest first. The timeline is
   * read page by page up to a bound; past it, messages are not numbered.
   */
  async userMessages(threadId: string): Promise<UserMessage[]> {
    const rows = new Map<number, ConversationRow>();
    let before: { anchorId: string; anchorSeq: number } | null = null;
    let complete = false;
    for (let page = 0; page < TIMELINE_PAGES; page += 1) {
      const timeline = await this.sdk.threads.timeline({
        threadId,
        segmentLimit: "100", // bb's maximum
        ...(before === null ? {} : { beforeAnchorId: before.anchorId, beforeAnchorSeq: String(before.anchorSeq) }),
      });
      for (const row of conversationRows(timeline.rows)) if (row.role === "user") rows.set(row.sourceSeqEnd, row);
      const next = (timeline as { timelinePage?: { hasOlderRows?: boolean; olderCursor?: { anchorId: string; anchorSeq: number } | null } }).timelinePage;
      if (next?.hasOlderRows !== true || next.olderCursor === undefined || next.olderCursor === null) {
        complete = true;
        break;
      }
      before = next.olderCursor;
    }
    // A message that joined a running turn (a steer) shares that turn's id
    // with the message that started it; only the first one starts a turn.
    // (A steer sent to an idle thread starts its own turn and counts.)
    const turns = new Set<string>();
    const messages: UserMessage[] = [];
    for (const row of [...rows.values()].sort((a, b) => a.sourceSeqEnd - b.sourceSeqEnd)) {
      if (row.requestStatus === "rejected") continue;
      if (row.turnId !== null) {
        if (turns.has(row.turnId)) continue;
        turns.add(row.turnId);
      }
      messages.push({
        number: complete ? messages.length + 1 : null,
        sourceSeqEnd: row.sourceSeqEnd,
        text: row.text,
        fromUser: row.initiator === null || row.initiator === "user",
      });
    }
    this.deps.log.debug(`userMessages ${threadId}: ${rows.size} user rows, ${messages.length} started turns (${messages.map((message) => message.sourceSeqEnd).join(", ")})`);
    return messages;
  }

  /**
   * The note suggested for the user's next message after a restore that left
   * the conversation as it was: which turns the files no longer reflect.
   * Null when the restore undid no turn.
   */
  async noteFor(threadId: string, checkpoint: CheckpointRow): Promise<string | null> {
    const generic = "Files were restored to an earlier checkpoint, so the latest turns' file changes are gone. Re-read files before editing.";
    if (checkpoint.threadId !== threadId || checkpoint.eventMark === null) return generic;
    const mark = checkpoint.eventMark;
    const messages = await this.userMessages(threadId);
    const undone = messages.filter((message) => (checkpoint.kind === "before-turn" ? message.sourceSeqEnd >= mark : message.sourceSeqEnd > mark));
    const first = undone[0];
    if (first === undefined) return null;
    const quote = `“${excerpt(first.text, 60) ?? "…"}”`;
    if (first.number === null) {
      const later = undone.length - 1;
      return `Files were restored to before my message ${quote}; that turn${later > 0 ? ` and the ${later} after it were` : " was"} undone. Re-read files before editing.`;
    }
    const last = undone.at(-1)!.number!;
    const where =
      checkpoint.kind === "before-turn"
        ? `before message ${first.number} (${quote})`
        : first.number > 1
          ? `the end of turn ${first.number - 1}`
          : "before message 1";
    const range = first.number === last ? `turn ${first.number} was undone` : `turns ${first.number}–${last} were undone`;
    return `Files were restored to ${where}; ${range}. Re-read files before editing.`;
  }

  /** Whether the thread's provider can replace a message; unknown counts as yes and bb decides. */
  private async canEditMessages(threadId: string): Promise<boolean> {
    try {
      const thread = await this.getThread(threadId);
      const now = this.now();
      if (this.providerEdits === null || now - this.providerEdits.at > 60_000) {
        const listed = (await this.sdk.providers.list()) as { providers?: Array<{ id: string; capabilities?: { supportsSessionRewind?: boolean } }> };
        this.providerEdits = {
          at: now,
          byProvider: new Map((listed.providers ?? []).map((provider) => [provider.id, provider.capabilities?.supportsSessionRewind !== false])),
        };
      }
      const providerId = (thread as { providerId?: string }).providerId;
      return providerId === undefined ? true : (this.providerEdits.byProvider.get(providerId) ?? true);
    } catch {
      return true;
    }
  }

  /** A before-turn checkpoint for the turn an edit starts: the restored files. */
  private async beforeEditedTurn(threadId: string, text: string): Promise<CheckpointRow | null> {
    try {
      const { workspace } = await this.resolveWorkspace(threadId);
      const row = this.insert({
        threadId,
        workspace,
        kind: "before-turn",
        label: null,
        attempt: "start-turn",
        eventMark: await this.eventMark(threadId),
        messageExcerpt: excerpt(text),
      });
      return await this.runSnapshot(row);
    } catch (error) {
      this.deps.log.info(`no checkpoint before the edited message of ${threadId}: ${errorText(error)}`);
      return null;
    }
  }

  /** The turn-starting message a before-turn checkpoint was taken for (CLI edit). */
  async messageAfter(threadId: string, checkpointId: string): Promise<UserMessage> {
    const checkpoint = this.requireCheckpoint(checkpointId);
    if (checkpoint.threadId !== threadId || checkpoint.kind !== "before-turn" || checkpoint.attempt !== "start-turn" || checkpoint.eventMark === null) {
      throw new RewindError(
        "not_a_message_checkpoint",
        `Checkpoint ${checkpoint.id} is not the one taken before one of this thread's messages.`,
        "Pick a \"before\" checkpoint from `bb rewind list`: the one listed with the message you want to edit.",
      );
    }
    const mark = checkpoint.eventMark;
    const message = (await this.userMessages(threadId)).find((candidate) => candidate.sourceSeqEnd >= mark);
    if (message === undefined) throw new RewindError("message_not_found", `No message of this thread follows checkpoint ${checkpoint.id}.`);
    return message;
  }

  /** Store (or clear) the note for the thread's next message; never sent by Rewind. */
  private async recordNote(threadId: string, restoreId: string, checkpoint: CheckpointRow): Promise<string | null> {
    let text: string | null;
    try {
      text = await this.noteFor(threadId, checkpoint);
    } catch (error) {
      this.deps.log.info(`could not word the note for ${threadId}: ${errorText(error)}`);
      text = "Files were restored to an earlier checkpoint, so the latest turns' file changes are gone. Re-read files before editing.";
    }
    if (text === null) this.store.deleteNote(threadId);
    else this.store.setNote({ threadId, restoreId, text, createdAt: this.now() });
    this.deps.publish(threadId);
    return text;
  }

  note(threadId: string): { text: string; createdAt: number } | null {
    const note = this.store.getNote(threadId);
    return note === null ? null : { text: note.text, createdAt: note.createdAt };
  }

  dismissNote(threadId: string): boolean {
    const dismissed = this.store.deleteNote(threadId);
    if (dismissed) this.deps.publish(threadId);
    return dismissed;
  }

  /**
   * "Restore files and edit this message": restore the files to before a user
   * message (a normal, undoable restore), then have bb replace that message,
   * which discards it and every later turn. The files are written before the
   * edit is sent, so its new turn starts on them. If bb or the provider
   * refuses the edit, the restore stays and the note is offered instead.
   */
  async editMessage(input: { threadId: string; sourceSeqEnd: number; text: string; checkpointId?: string }): Promise<{ outcome: RestoreOutcome; edit: EditResult }> {
    const text = input.text.trim();
    if (text.length === 0) throw new RewindError("empty_message", "The new message is empty.");
    const message = (await this.userMessages(input.threadId)).find((candidate) => candidate.sourceSeqEnd === input.sourceSeqEnd);
    if (message === undefined) {
      throw new RewindError(
        "message_not_found",
        `This thread has no message that started a turn at event ${input.sourceSeqEnd}.`,
        "Only your own messages that started a turn can be edited (not steers, and not messages a fork inherited).",
      );
    }
    if (!message.fromUser) {
      // bb edits only messages a person typed; nothing was restored.
      throw new RewindError(
        "message_not_editable",
        "That message was sent by another thread or agent, and bb edits only messages you typed. Nothing was restored.",
        "Restore the files without editing (bb rewind restore … --yes); Rewind then suggests a note for your next message.",
      );
    }
    let checkpointId = input.checkpointId;
    if (checkpointId === undefined) {
      const resolved = await this.resolveMessage(input.threadId, { role: "user", sourceSeqEnd: input.sourceSeqEnd });
      if (resolved.checkpoint === null) {
        throw new RewindError("no_checkpoint", "There is no checkpoint from before this message, so its files cannot be restored.");
      }
      checkpointId = resolved.checkpoint.id;
    }
    const checkpoint = this.requireCheckpoint(checkpointId);
    if (checkpoint.eventMark !== null && checkpoint.eventMark > input.sourceSeqEnd) {
      throw new RewindError("checkpoint_after_message", `Checkpoint ${checkpoint.id} was taken after that message, so it is not the files as they were before it.`);
    }
    const outcome = await this.restore(input.threadId, checkpoint.id, "restore", { note: false });
    // bb's edit starts the new turn itself, without the dispatch gate: take
    // the checkpoint the gate would have, of the files just restored.
    const before = await this.beforeEditedTurn(input.threadId, text);
    try {
      const response = await this.sdk.threads.editMessage({
        threadId: input.threadId,
        expectedRequestSequence: input.sourceSeqEnd,
        input: [{ type: "text", text, mentions: [] }],
        operationId: newId("op", this.now()),
      });
      if (this.store.deleteNote(input.threadId)) this.deps.publish(input.threadId);
      return { outcome, edit: { ok: true, requestSequence: response.requestSequence, message: message.number } };
    } catch (error) {
      this.deps.log.info(`bb did not edit message ${input.sourceSeqEnd} of ${input.threadId}: ${errorText(error)}`);
      // No message follows it after all.
      if (before !== null) await this.deleteRefs(this.store.deleteCheckpoints([before.id]));
      const note = await this.recordNote(input.threadId, outcome.restore.id, checkpoint);
      return { outcome: { ...outcome, note }, edit: { ok: false, error: errorText(error), message: message.number } };
    }
  }

  async undo(threadId: string, restoreId?: string): Promise<RestoreOutcome> {
    const { workspace } = await this.resolveWorkspace(threadId);
    // Failed restores count when they changed files: skipping a newer partial
    // one would roll the workspace back further than the user expects.
    const restore = restoreId !== undefined ? this.store.getRestore(restoreId) : this.store.latestRestoreInWorkspace(workspace.hostId, workspace.path);
    if (restore === null) throw new RewindError("nothing_to_undo", "There is no restore to undo in this workspace.");
    if (restore.hostId !== workspace.hostId || restore.workspace !== workspace.path) {
      throw new RewindError("different_workspace", `Restore ${restore.id} was applied to another workspace.`);
    }
    if (restore.preRestoreCheckpointId === null) {
      throw new RewindError("nothing_to_undo", `Restore ${restore.id} failed before changing any file, so there is nothing to undo.`);
    }
    if (restore.undoneBy !== null) {
      throw new RewindError("already_undone", `Restore ${restore.id} was already undone by ${restore.undoneBy}.`, "Undo that one instead: `bb rewind undo` undoes the latest restore.");
    }
    const outcome = await this.restore(threadId, restore.preRestoreCheckpointId, "undo");
    this.store.markUndone(restore.id, outcome.restore.id);
    this.deps.publish(threadId);
    return outcome;
  }

  async stopRunning(threadId: string): Promise<string[]> {
    const { workspace } = await this.resolveWorkspace(threadId);
    const running = await this.runningThreads(workspace.environmentId, threadId);
    const stopped: string[] = [];
    for (const thread of running) {
      await this.sdk.threads.stop({ threadId: thread.id });
      stopped.push(thread.id);
    }
    // Stop waits for the interrupt; give the runtime a moment to settle.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await this.runningThreads(workspace.environmentId, threadId)).length === 0) break;
      await this.sleep(500);
    }
    return stopped;
  }

  // --------------------------------------------------------------- fork

  async fork(input: { threadId: string; checkpointId: string; anchorSeq?: number | undefined; prompt?: string | undefined; title?: string | undefined }): Promise<ForkJob> {
    const checkpoint = this.requireCheckpoint(input.checkpointId);
    const source = await this.getThread(input.threadId);
    if (checkpoint.threadId !== source.id && checkpoint.threadId !== source.sourceThreadId) {
      throw new RewindError("checkpoint_not_in_thread", `Checkpoint ${checkpoint.id} does not belong to thread ${source.id}.`);
    }
    if (checkpoint.head === null) {
      throw new RewindError("fork_needs_git", "Forking with files creates a new worktree, which needs the workspace to be a git repository.");
    }
    const job = this.store.insertFork({
      id: newId("fk", this.now()),
      sourceThreadId: checkpoint.threadId,
      checkpointId: checkpoint.id,
      anchorSeq: input.anchorSeq ?? null,
      forkThreadId: null,
      status: "running",
      step: "Creating the fork",
      error: null,
      prompt: input.prompt ?? null,
      createdAt: this.now(),
      updatedAt: this.now(),
    });
    void this.track(this.runFork(job.id, checkpoint, input));
    return toForkJob(job);
  }

  forkStatus(jobId: string): ForkJob {
    const job = this.store.getFork(jobId);
    if (job === null) throw new RewindError("fork_not_found", `Fork job ${jobId} does not exist.`);
    return toForkJob(job);
  }

  private async runFork(jobId: string, checkpoint: CheckpointRow, input: { threadId: string; anchorSeq?: number | undefined; prompt?: string | undefined; title?: string | undefined }): Promise<void> {
    const step = (text: string) => this.store.updateFork(jobId, { step: text }, this.now());
    let forkThreadId: string | null = null;
    try {
      const source = await this.getThread(checkpoint.threadId);
      let anchor = input.anchorSeq;
      if (anchor === undefined) {
        const timeline = await this.sdk.threads.timeline({ threadId: checkpoint.threadId });
        anchor = anchorForCheckpoint(checkpoint, conversationRows(timeline.rows));
      }
      const branch = checkpoint.head?.branch ?? null;
      const fork = await this.sdk.threads.fork({
        sourceThreadId: checkpoint.threadId,
        ...(anchor === undefined ? {} : { sourceSeqEnd: anchor }),
        environment: {
          type: "host",
          hostId: checkpoint.hostId,
          workspace: {
            type: "managed-worktree",
            baseBranch: branch === null ? { kind: "default" } : { kind: "named", name: branch },
          },
        },
        title: input.title ?? `${source.title ?? source.titleFallback ?? "Thread"} (rewound)`.slice(0, 200),
        visibility: source.visibility,
        pluginMetadata: { forkedFrom: { threadId: checkpoint.threadId, checkpointId: checkpoint.id } },
      });
      forkThreadId = fork.id;
      this.store.updateFork(jobId, { forkThreadId, step: "Waiting for the new worktree" }, this.now());

      const deadline = this.now() + FORK_ENVIRONMENT_WAIT_MS;
      let workspace: ResolvedWorkspace | null = null;
      while (workspace === null) {
        if (this.disposed) throw new Error("Rewind was reloaded while the fork was being prepared.");
        try {
          workspace = (await this.resolveWorkspace(forkThreadId)).workspace;
        } catch (error) {
          if (error instanceof RewindError && (error.code === "no_environment" || error.code === "environment_not_ready")) {
            if (this.now() > deadline) throw new Error("The new worktree was not ready in time.");
            await this.sleep(1_000);
            continue;
          }
          throw error;
        }
      }

      step("Restoring the checkpoint's files");
      this.beginRestore(workspace.environmentId);
      try {
        await this.applyRestore(forkThreadId, workspace, checkpoint, this.sourceFor(checkpoint, workspace), "fork");
      } finally {
        this.endRestore(workspace.environmentId);
      }

      if (input.prompt !== undefined && input.prompt.trim().length > 0) {
        step("Sending the prompt");
        await this.sdk.threads.send({ threadId: forkThreadId, mode: "auto", input: [{ type: "text", text: input.prompt, mentions: [] }] });
      }
      this.store.updateFork(jobId, { status: "done", step: "Done" }, this.now());
    } catch (error) {
      const message = forkThreadId === null ? errorText(error) : `The fork ${forkThreadId} exists, but its files were not prepared: ${errorText(error)}`;
      this.deps.log.warn(`fork ${jobId} failed: ${message}`);
      this.store.updateFork(jobId, { status: "failed", error: message.slice(0, 2_000) }, this.now());
    } finally {
      this.deps.publish(input.threadId);
      if (forkThreadId !== null) this.deps.publish(forkThreadId);
    }
  }

  /** Wait for a fork job to finish (CLI). */
  async waitForFork(jobId: string, timeoutMs: number): Promise<ForkJob> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const job = this.forkStatus(jobId);
      if (job.status !== "running" || this.now() > deadline) return job;
      await this.sleep(500);
    }
  }

  // ---------------------------------------------------------- retention

  async retention(options: { dryRun: boolean }): Promise<{
    deleted: number;
    byReason: Record<string, number>;
    refsDeleted: number;
    shadowsRemoved: number;
    hostsSkipped: string[];
  }> {
    const now = this.now();
    const settings = this.deps.settings();
    if (!options.dryRun) {
      this.store.failStalePending(now - PENDING_STALE_MS, now);
    }
    const threadIds = this.store.threadIds();
    const threads = new Map<string, { id: string; archivedAt: number | null } | null>();
    for (const threadId of threadIds) {
      try {
        const thread = await this.sdk.threads.get({ threadId });
        threads.set(threadId, thread.deletedAt !== null ? null : { id: thread.id, archivedAt: thread.archivedAt });
      } catch (error) {
        // A 404 means the thread is gone; any other error leaves it unknown.
        if (/not.?found|404/iu.test(errorText(error))) threads.set(threadId, null);
      }
    }
    const checkpoints = threadIds.flatMap((threadId) => this.store.listCheckpoints(threadId));
    const protectedIds = new Set<string>();
    for (const threadId of threadIds) {
      const latest = this.store.listRestores(threadId, 1).at(-1);
      if (latest !== undefined) {
        protectedIds.add(latest.targetCheckpointId);
        if (latest.preRestoreCheckpointId !== null) protectedIds.add(latest.preRestoreCheckpointId);
      }
    }
    const failedCreatedAt = new Map(checkpoints.filter((row) => row.status === "failed" || row.status === "unsupported").map((row) => [row.id, row.createdAt]));
    const decision = selectForDeletion(
      {
        checkpoints,
        threads,
        protectedIds,
        maxPerThread: settings.maxCheckpointsPerThread,
        retentionDays: settings.retentionDays,
        now,
      },
      failedCreatedAt,
    );
    const byReason: Record<string, number> = {};
    for (const reason of Object.values(decision.reasons)) byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (options.dryRun) {
      const unused = await this.unusedShadows(new Set(decision.deleteIds), new Set());
      return { deleted: decision.deleteIds.length, byReason, refsDeleted: 0, shadowsRemoved: unused.stores.length, hostsSkipped: unused.hostsSkipped };
    }

    const deleted = this.store.deleteCheckpoints(decision.deleteIds);
    await this.deleteRefs(deleted);
    const touchedThreads = new Set(checkpoints.filter((row) => decision.reasons[row.id] !== undefined).map((row) => row.threadId));
    for (const threadId of touchedThreads) this.deps.publish(threadId);

    // Reconcile every workspace that still has checkpoints, then gc it.
    let refsDeleted = 0;
    const hostsSkipped = new Set<string>();
    for (const { hostId, workspace } of this.store.workspaces()) {
      if (hostsSkipped.has(hostId)) continue;
      try {
        const keep = this.store.checkpointsForWorkspace(hostId, workspace).map((row) => row.id);
        const result = await this.deps.host.call(
          "reconcile",
          { workspace, keepCheckpointIds: keep, minAgeMs: 60 * 60 * 1000, gc: true },
          { hostId, timeoutMs: GC_TIMEOUT_MS },
        );
        refsDeleted += result.deletedRefs;
      } catch (error) {
        hostsSkipped.add(hostId);
        this.deps.log.info(`retention skipped host ${hostId}: ${errorText(error)}`);
      }
    }

    // Remove shadows whose environment is gone and that no checkpoint needs.
    const unused = await this.unusedShadows(new Set(), hostsSkipped);
    for (const hostId of unused.hostsSkipped) hostsSkipped.add(hostId);
    let shadowsRemoved = 0;
    for (const { hostId, key } of unused.stores) {
      if (hostsSkipped.has(hostId)) continue;
      try {
        const removed = await this.deps.host.call("removeShadow", { key }, { hostId, timeoutMs: 5 * 60_000 });
        if (removed.removed) shadowsRemoved += 1;
      } catch (error) {
        hostsSkipped.add(hostId);
        this.deps.log.info(`shadow cleanup skipped host ${hostId}: ${errorText(error)}`);
      }
    }
    return { deleted: deleted.length, byReason, refsDeleted, shadowsRemoved, hostsSkipped: [...hostsSkipped] };
  }

  /**
   * Stores whose workspace no longer has an environment and holds no
   * checkpoint (other than ones in `deleting`). Read-only.
   */
  private async unusedShadows(
    deleting: ReadonlySet<string>,
    skip: ReadonlySet<string>,
  ): Promise<{ stores: Array<{ hostId: string; key: string }>; hostsSkipped: string[] }> {
    const stores: Array<{ hostId: string; key: string }> = [];
    const hostsSkipped: string[] = [];
    let hosts: Array<{ id: string }> = [];
    try {
      hosts = await this.sdk.hosts.list();
    } catch {
      hosts = [];
    }
    for (const host of hosts) {
      if (skip.has(host.id)) continue;
      try {
        const { shadows } = await this.deps.host.call("listShadows", {}, { hostId: host.id, timeoutMs: 60_000 });
        if (shadows.length === 0) continue;
        const environments = await this.sdk.environments.list({ hostId: host.id, limit: 1_000 });
        const livePaths = new Set(environments.filter((environment) => environment.status !== "destroyed" && environment.path !== null).map((environment) => environment.path!));
        for (const shadow of shadows) {
          if (shadow.workspace.length === 0) continue;
          if (livePaths.has(shadow.workspace)) continue;
          if (this.store.checkpointsForWorkspace(host.id, shadow.workspace).some((row) => !deleting.has(row.id))) continue;
          stores.push({ hostId: host.id, key: shadow.key });
        }
      } catch (error) {
        hostsSkipped.push(host.id);
        this.deps.log.info(`shadow cleanup skipped host ${host.id}: ${errorText(error)}`);
      }
    }
    return { stores, hostsSkipped };
  }

  /** Delete one thread's checkpoints (CLI prune --thread). */
  async pruneThread(threadId: string, options: { dryRun: boolean }): Promise<number> {
    const rows = this.store.listCheckpoints(threadId);
    if (options.dryRun) return rows.length;
    return this.onThreadDeleted(threadId);
  }

  // ------------------------------------------------------------- status

  status() {
    // Samples from before the queueing gate (no decision) measured a
    // different thing: how long the old budget held a message.
    const samples = this.store.gateSamples().filter((sample) => sample.decision !== null);
    const active = samples.filter((sample) => !sample.outcome.startsWith("skipped"));
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const stats = (values: number[]) => {
      const ordered = sorted(values);
      return ordered.length === 0 ? null : { p50: percentile(ordered, 0.5), p95: percentile(ordered, 0.95), max: ordered.at(-1)! };
    };
    const waits = this.store.gateWaits();
    const queued = waits.flatMap((wait) => {
      const end = wait.dispatchedAt ?? wait.reattemptAt;
      return end === null ? [] : [end - wait.createdAt];
    });
    const recheck = waits.flatMap((wait) => (wait.recheckAt !== null && wait.reattemptAt !== null && wait.reattemptAt >= wait.recheckAt ? [wait.reattemptAt - wait.recheckAt] : []));
    return {
      settings: this.settingsDto(),
      gate: {
        samples: samples.length,
        snapshots: active.filter((sample) => sample.checkpointId !== null).length,
        // First waits only: a row kept waiting for the same checkpoint is not a new message.
        waits: active.filter((sample) => sample.outcome === "wait:snapshot" || sample.outcome === "wait:restore").length,
        released: active.filter((sample) => sample.outcome === "released:pending" || sample.outcome === "released:orphaned").length,
        failed: active.filter((sample) => sample.outcome.startsWith("failed") || sample.outcome === "error").length,
        heldMs: stats(active.map((sample) => sample.waitedMs)),
        snapshotMs: stats(samples.flatMap((sample) => (sample.snapshotMs === null ? [] : [sample.snapshotMs]))),
        queuedMs: stats(queued),
        recheckMs: stats(recheck),
      },
    };
  }
}
