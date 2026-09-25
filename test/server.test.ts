// Server behaviour through the SDK's fake plugin host, with host RPC running
// the real host handlers (real git) against temp directories.
import { chmod, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { clearUserRepoCaches } from "../src/host/user-repo";
import type { CheckpointDto, RestoreOutcome } from "../src/rpc-contract";
import { exists, initRepo, removeTempDirs, tempDir, userGit, write } from "./helpers/fs";
import { createWorld, queuedRow, type World } from "./helpers/world";

const worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.harness.lifecycle.dispose();
  clearUserRepoCaches();
  await removeTempDirs();
});

async function setup(options: Parameters<typeof createWorld>[0] = {}) {
  const world = await createWorld(options);
  worlds.push(world);
  const workspace = await tempDir("ws");
  await initRepo(workspace, { "scratch.txt": "zero\n", "keep.md": "keep\n" });
  const environment = world.addEnvironment(workspace);
  const thread = world.addThread({ environmentId: environment.id });
  return { world, workspace, environment, thread };
}

type ListResult = {
  checkpoints: CheckpointDto[];
  restores: Array<{ id: string; kind: string; status: string; preRestoreCheckpointId: string | null; undoneBy: string | null }>;
  workspace: { running: Array<{ id: string }> } | null;
};

async function list(world: World, threadId: string): Promise<ListResult> {
  return world.rpc<ListResult>("list", { threadId });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await delay(20);
  }
}

describe("the message.dispatch gate", () => {
  it("takes a before-turn checkpoint and proceeds", async () => {
    const { world, thread } = await setup();
    world.appendEvent(thread.id, "thread/started");
    const decision = await world.dispatch(thread, { input: { text: "Refactor   the\nparser please", blocks: [] } });
    expect(decision).toEqual({ action: "proceed" });
    const { checkpoints } = await list(world, thread.id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      kind: "before-turn",
      attempt: "start-turn",
      status: "ok",
      late: false,
      eventMark: 1,
      messageExcerpt: "Refactor the parser please",
      baseline: true,
    });
    const status = await world.rpc<{ gate: { snapshots: number; waits: number; heldMs: { max: number } | null } }>("status", null);
    expect(status.gate).toMatchObject({ snapshots: 1, waits: 0 });
    expect(status.gate.heldMs?.max).toBeLessThan(1_000);
  });

  it("fails open when git errors: the message proceeds and the checkpoint is marked failed", async () => {
    const { world, thread } = await setup({
      beforeHostCall: (method) => {
        if (method === "snapshot") throw new Error("fatal: simulated git failure");
      },
    });
    const decision = await world.dispatch(thread);
    expect(decision).toEqual({ action: "proceed" });
    const { checkpoints } = await list(world, thread.id);
    expect(checkpoints[0]).toMatchObject({ status: "failed" });
    expect(checkpoints[0]!.error).toContain("simulated git failure");
    expect(world.harness.inspection.logEntries.some((entry) => entry.message.includes("simulated git failure"))).toBe(true);
  });

  it("holds a slow checkpoint's message at most gateHoldMs, queues it, and releases it with a recheck once saved", async () => {
    const { world, thread } = await setup({
      settings: { gateHoldMs: 150 },
      beforeHostCall: async (method) => {
        if (method === "snapshot") await delay(800);
      },
    });
    const rechecksBefore = world.harness.inspection.recheckCount;
    const started = Date.now();
    const decision = await world.dispatch(thread);
    const held = Date.now() - started;
    expect(decision).toMatchObject({ action: "wait", reason: "Rewind: saving a checkpoint…" });
    expect((decision as { sendAt: number }).sendAt - started).toBeGreaterThanOrEqual(29_000);
    expect(held).toBeLessThan(450);
    const row = queuedRow(thread.id);
    await world.harness.behavior.emitThreadEvent("message.queued", { entry: row });

    // The checkpoint is saved, then Rewind asks bb to re-attempt the message.
    const pending = (await list(world, thread.id)).checkpoints[0]!;
    expect(pending.status).toBe("pending");
    expect(await world.settled(pending.id)).toMatchObject({ status: "ok", late: false });
    await until(() => world.harness.inspection.recheckCount > rechecksBefore);

    // The re-attempt reuses the saved checkpoint and proceeds at once.
    const again = Date.now();
    expect(await world.dispatch(thread, { queuedMessages: [row] })).toEqual({ action: "proceed" });
    expect(Date.now() - again).toBeLessThan(150);
    await world.harness.behavior.emitThreadEvent("message.dispatched", { entry: row });
    const checkpoints = (await list(world, thread.id)).checkpoints;
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ status: "ok", late: false });

    const status = await world.rpc<{ gate: { waits: number; heldMs: { max: number }; queuedMs: { max: number } | null; recheckMs: { max: number } | null } }>("status", null);
    expect(status.gate.waits).toBe(1);
    expect(status.gate.heldMs.max).toBeLessThan(450);
    expect(status.gate.queuedMs?.max).toBeGreaterThanOrEqual(500);
    expect(status.gate.recheckMs).not.toBeNull();
  });

  it("keeps a message in its one wait, with its first deadline, while its checkpoint is still being saved", async () => {
    const { world, thread } = await setup({
      settings: { gateHoldMs: 100 },
      beforeHostCall: async (method) => {
        if (method === "snapshot") await delay(900);
      },
    });
    const first = await world.dispatch(thread);
    expect(first).toMatchObject({ action: "wait" });
    const row = queuedRow(thread.id);
    await world.harness.behavior.emitThreadEvent("message.queued", { entry: row });
    // bb re-attempts the row on its own (or another plugin rechecks) before the checkpoint is saved.
    const started = Date.now();
    const again = await world.dispatch(thread, { queuedMessages: [row] });
    expect(Date.now() - started).toBeLessThan(100);
    expect(again).toEqual({ action: "wait", reason: "Rewind: saving a checkpoint…", sendAt: (first as { sendAt: number }).sendAt });
    // Saved: the next re-attempt goes, and the checkpoint is exact.
    const checkpoint = (await list(world, thread.id)).checkpoints[0]!;
    expect(await world.settled(checkpoint.id)).toMatchObject({ status: "ok", late: false });
    expect(await world.dispatch(thread, { queuedMessages: [row] })).toEqual({ action: "proceed" });
    expect((await list(world, thread.id)).checkpoints).toHaveLength(1);
  });

  it("keeps a message queued when Rewind's recheck for another message wakes it before its checkpoint is saved", async () => {
    let slowWorkspace = "";
    const { world, thread } = await setup({
      settings: { gateHoldMs: 100 },
      beforeHostCall: async (method, input) => {
        if (method === "snapshot") await delay((input as { workspace: string }).workspace === slowWorkspace ? 1_500 : 300);
      },
    });
    slowWorkspace = world.environments.get(thread.environmentId!)!.path!;
    const otherWorkspace = await tempDir("ws-other");
    await initRepo(otherWorkspace, { "a.txt": "a\n" });
    const other = world.addThread({ environmentId: world.addEnvironment(otherWorkspace).id });

    const rechecks = world.harness.inspection.recheckCount;
    expect(await world.dispatch(thread)).toMatchObject({ action: "wait" });
    const slowRow = queuedRow(thread.id);
    await world.harness.behavior.emitThreadEvent("message.queued", { entry: slowRow });
    expect(await world.dispatch(other)).toMatchObject({ action: "wait" });
    const quickRow = queuedRow(other.id);
    await world.harness.behavior.emitThreadEvent("message.queued", { entry: quickRow });

    // The quick checkpoint is saved; bb's recheck walk re-attempts both rows.
    await until(() => world.harness.inspection.recheckCount > rechecks);
    const started = Date.now();
    expect(await world.dispatch(thread, { queuedMessages: [slowRow] })).toMatchObject({ action: "wait", reason: "Rewind: saving a checkpoint…" });
    expect(Date.now() - started).toBeLessThan(100);
    expect(await world.dispatch(other, { queuedMessages: [quickRow] })).toEqual({ action: "proceed" });

    // Its own checkpoint saved, the slow message goes, and the checkpoint is exact.
    const slowCheckpoint = (await list(world, thread.id)).checkpoints[0]!;
    expect(await world.settled(slowCheckpoint.id)).toMatchObject({ status: "ok", late: false });
    await until(() => world.harness.inspection.recheckCount > rechecks + 1);
    expect(await world.dispatch(thread, { queuedMessages: [slowRow] })).toEqual({ action: "proceed" });
    const status = await world.rpc<{ gate: { waits: number } }>("status", null);
    expect(status.gate.waits).toBe(2);
  });

  it("recognizes its queued rows by their wait even after a restart", async () => {
    const { world, thread } = await setup({
      settings: { gateHoldMs: 100 },
      beforeHostCall: async (method) => {
        if (method === "snapshot") await delay(700);
      },
    });
    // A row Rewind queued in an earlier load: this load has no record of it.
    const row = queuedRow(thread.id, { createdAt: Date.now() - 5_000 });
    expect(await world.dispatch(thread, { queuedMessages: [row] })).toEqual({ action: "proceed" });
    // Its reason appended to another plugin's wait counts too.
    const shared = queuedRow(thread.id, { waitingOn: { kind: "plugin", pluginId: "limiter", reason: "At capacity. Rewind: saving a checkpoint…" } });
    expect(await world.dispatch(thread, { queuedMessages: [shared] })).toEqual({ action: "proceed" });
  });

  it("treats Send now, which skips the hook, as the message going out", async () => {
    const { world, thread } = await setup({
      settings: { gateHoldMs: 100 },
      beforeHostCall: async (method) => {
        if (method === "snapshot") await delay(700);
      },
    });
    expect(await world.dispatch(thread)).toMatchObject({ action: "wait" });
    const row = queuedRow(thread.id);
    await world.harness.behavior.emitThreadEvent("message.queued", { entry: row });
    await world.harness.behavior.emitThreadEvent("message.dispatched", { entry: row });
    const checkpoint = (await list(world, thread.id)).checkpoints[0]!;
    expect(await world.settled(checkpoint.id)).toMatchObject({ status: "ok", late: true });
  });

  it("releases the message when the queued checkpoint fails", async () => {
    const { world, thread } = await setup({
      settings: { gateHoldMs: 50 },
      beforeHostCall: async (method) => {
        if (method === "snapshot") {
          await delay(300);
          throw new Error("disk unavailable");
        }
      },
    });
    const rechecksBefore = world.harness.inspection.recheckCount;
    expect(await world.dispatch(thread)).toMatchObject({ action: "wait" });
    const row = queuedRow(thread.id);
    await world.harness.behavior.emitThreadEvent("message.queued", { entry: row });
    await until(() => world.harness.inspection.recheckCount > rechecksBefore);
    // The re-attempt proceeds without waiting for a second snapshot.
    const started = Date.now();
    expect(await world.dispatch(thread, { queuedMessages: [row] })).toEqual({ action: "proceed" });
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("answers within the hold even when the host call hangs", async () => {
    const { world, thread } = await setup({
      settings: { gateHoldMs: 100 },
      beforeHostCall: async (method) => {
        if (method === "snapshot") await delay(3_000);
      },
    });
    const started = Date.now();
    await expect(world.dispatch(thread)).resolves.toMatchObject({ action: "wait" });
    expect(Date.now() - started).toBeLessThan(600);
  });

  it("re-attempts messages still queued from a previous load when the plugin starts", async () => {
    const { world } = await setup();
    await until(() => world.harness.inspection.recheckCount >= 1);
  });

  it("skips disabled plugins, excluded projects, threads without a workspace, and queued messages", async () => {
    const { world, thread } = await setup({ settings: { enabled: false } });
    await world.dispatch(thread);
    expect((await list(world, thread.id)).checkpoints).toHaveLength(0);

    await world.harness.behavior.setSettings({ enabled: true, excludedProjects: "Some other, TEST PROJECT" });
    await world.dispatch(thread);
    expect((await list(world, thread.id)).checkpoints).toHaveLength(0);

    await world.harness.behavior.setSettings({ excludedProjects: "" });
    const fresh = world.addThread({ environmentId: null });
    await expect(world.dispatch(fresh)).resolves.toEqual({ action: "proceed" });
    expect((await list(world, fresh.id)).checkpoints).toHaveLength(0);

    thread.status = "active";
    await world.dispatch(thread, { attempt: "start-turn" });
    expect((await list(world, thread.id)).checkpoints).toHaveLength(0);

    const samples = await world.rpc<{ gate: { samples: number; snapshots: number } }>("status", null);
    expect(samples.gate).toMatchObject({ samples: 4, snapshots: 0 });
  });

  it("does not hold a steer that joins a running turn", async () => {
    const { world, thread } = await setup({
      beforeHostCall: async (method) => {
        if (method === "snapshot") await delay(800);
      },
    });
    thread.status = "active";
    const started = Date.now();
    await world.dispatch(thread, { attempt: "join-turn" });
    expect(Date.now() - started).toBeLessThan(500);
    const row = (await list(world, thread.id)).checkpoints[0]!;
    expect(row.attempt).toBe("join-turn");
    expect(await world.settled(row.id)).toMatchObject({ status: "ok", late: false });
  });

  it("reuses the checkpoint when the same dispatch is asked about twice", async () => {
    const { world, thread } = await setup();
    await world.dispatch(thread);
    await world.dispatch(thread);
    expect((await list(world, thread.id)).checkpoints).toHaveLength(1);
  });

  it("holds no message in another workspace longer than gateHoldMs while a slow snapshot runs", async () => {
    const { world, thread } = await setup({
      settings: { gateHoldMs: 1_000 },
      beforeHostCall: async (method, input) => {
        if (method === "snapshot" && (input as { workspace: string }).workspace === slowWorkspace) await delay(2_000);
      },
    });
    const slowWorkspace = world.environments.get(thread.environmentId!)!.path!;
    expect(await world.dispatch(thread)).toMatchObject({ action: "wait" });
    const otherWorkspace = await tempDir("ws-other");
    await initRepo(otherWorkspace, { "a.txt": "a\n" });
    const other = world.addThread({ environmentId: world.addEnvironment(otherWorkspace).id });
    const started = Date.now();
    expect(await world.dispatch(other)).toEqual({ action: "proceed" });
    // Its own snapshot, not the slow one elsewhere, decides how long it is held.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("messages sent while a restore writes files", () => {
  async function slowRestoreWorld(delayMs = 800) {
    let signalRestoreStarted!: () => void;
    const restoreStarted = new Promise<void>((resolve) => {
      signalRestoreStarted = resolve;
    });
    const context = await setup({
      beforeHostCall: async (method, input) => {
        if (method === "restore" && (input as { dryRun: boolean }).dryRun === false) {
          signalRestoreStarted();
          await delay(delayMs);
        }
      },
    });
    await context.world.dispatch(context.thread);
    const checkpoint = (await list(context.world, context.thread.id)).checkpoints[0]!;
    await write(context.workspace, "scratch.txt", "changed\n");
    const sibling = context.world.addThread({ environmentId: context.environment.id, title: "Sibling agent" });
    return { ...context, checkpoint, sibling, restoreStarted };
  }

  it("queues them until the restore ends, then their turn starts on the restored files", async () => {
    const { world, thread, checkpoint, sibling, restoreStarted } = await slowRestoreWorld();
    const restoring = world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    await restoreStarted;
    const rechecksBefore = world.harness.inspection.recheckCount;
    const started = Date.now();
    const decision = await world.dispatch(sibling);
    expect(Date.now() - started).toBeLessThan(200);
    expect(decision).toMatchObject({ action: "wait", reason: "Rewind: restoring files…" });
    const row = queuedRow(sibling.id, { waitingOn: { kind: "plugin", pluginId: "rewind", reason: "Rewind: restoring files…" } });
    await world.harness.behavior.emitThreadEvent("message.queued", { entry: row });

    // Another recheck re-attempts it mid-restore: it stays queued.
    expect(await world.dispatch(sibling, { queuedMessages: [row] })).toMatchObject({ action: "wait", reason: "Rewind: restoring files…" });

    const outcome = await restoring;
    expect(outcome.warnings).toEqual([]);
    await until(() => world.harness.inspection.recheckCount > rechecksBefore);
    // Its checkpoint was taken before the message was released: exact.
    const siblingCheckpoint = (await list(world, sibling.id)).checkpoints[0]!;
    expect(siblingCheckpoint).toMatchObject({ kind: "before-turn", status: "ok", late: false, messageExcerpt: "please change the files" });
    const released = Date.now();
    expect(await world.dispatch(sibling, { queuedMessages: [row] })).toEqual({ action: "proceed" });
    expect(Date.now() - released).toBeLessThan(150);
    expect((await list(world, sibling.id)).checkpoints).toHaveLength(1);
    const diff = await world.rpc<{ totalFiles: number }>("diff", { threadId: sibling.id, from: checkpoint.id, to: siblingCheckpoint.id });
    expect(diff.totalFiles).toBe(0);
  });

  it("queues them with automatic checkpoints off too", async () => {
    const { world, thread, checkpoint, sibling, restoreStarted } = await slowRestoreWorld();
    await world.harness.behavior.setSettings({ enabled: false });
    const restoring = world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    await restoreStarted;
    expect(await world.dispatch(sibling)).toMatchObject({ action: "wait", reason: "Rewind: restoring files…" });
    await restoring;
  });

  it("releases one at the safety cap with a warning, and warns about turns that skipped the queue", async () => {
    const { world, thread, checkpoint, sibling, restoreStarted } = await slowRestoreWorld();
    const restoring = world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    await restoreStarted;
    // A row queued behind this restore longer ago than the cap (rebuilt from its wait).
    const row = queuedRow(sibling.id, {
      createdAt: Date.now() - 21 * 60 * 1000,
      waitingOn: { kind: "plugin", pluginId: "rewind", reason: "Rewind: restoring files…" },
    });
    expect(await world.dispatch(sibling, { queuedMessages: [row] })).toEqual({ action: "proceed" });
    // Send now skips the hook; the sibling's turn starts during the restore.
    sibling.status = "active";
    const outcome = await restoring;
    expect(outcome.warnings).toEqual([
      expect.stringContaining("Sibling agent started a turn while the files were being restored"),
      expect.stringContaining("a message to Sibling agent was sent before it finished"),
    ]);
  });
});

describe("restores", () => {
  async function turn(world: World, thread: { id: string }, workspace: string, change: () => Promise<void>, text: string) {
    const userSeq = world.userMessage(thread.id, text);
    await world.dispatch(world.threads.get(thread.id)!, { input: { text, blocks: [] } });
    await change();
    const replySeq = world.assistantMessage(thread.id, `done: ${text}`);
    await world.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: world.threads.get(thread.id)!.environmentId }),
      lastAssistantText: "done",
    });
    void workspace;
    return { userSeq, replySeq };
  }

  it("maps messages to checkpoints, previews, restores, and undoes", async () => {
    const { world, thread, workspace } = await setup();
    world.appendEvent(thread.id, "thread/started");
    const first = await turn(world, thread, workspace, () => write(workspace, "scratch.txt", "one\n"), "write one");
    const second = await turn(
      world,
      thread,
      workspace,
      async () => {
        await write(workspace, "scratch.txt", "two\n");
        await write(workspace, "extra.txt", "extra\n");
      },
      "write two and extra",
    );

    // "Rewind to here" on message 2 targets the files as they were before it.
    const before2 = await world.rpc<{ match: string; checkpoint: CheckpointDto }>("resolveMessage", {
      threadId: thread.id,
      message: { role: "user", sourceSeqEnd: second.userSeq },
    });
    expect(before2.match).toBe("exact");
    expect(before2.checkpoint).toMatchObject({ kind: "before-turn", messageExcerpt: "write two and extra" });
    // …and the reply to message 1 targets the end of turn 1: the same files.
    const after1 = await world.rpc<{ match: string; checkpoint: CheckpointDto }>("resolveMessage", {
      threadId: thread.id,
      message: { role: "assistant", sourceSeqEnd: first.replySeq },
    });
    expect(after1).toMatchObject({ match: "exact", checkpoint: { kind: "after-turn" } });
    const after2 = await world.rpc<{ checkpoint: CheckpointDto }>("resolveMessage", {
      threadId: thread.id,
      message: { role: "assistant", sourceSeqEnd: second.replySeq },
    });
    expect(after2.checkpoint.stats).toMatchObject({ files: 2 });

    const preview = await world.rpc<{ plan: { writes: number; deletes: number; creates: number }; headMoved: boolean }>("preview", {
      threadId: thread.id,
      checkpointId: before2.checkpoint.id,
    });
    expect(preview.plan).toMatchObject({ writes: 1, deletes: 1, creates: 0 });
    expect(preview.headMoved).toBe(false);
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("two\n");

    const restored = await world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: before2.checkpoint.id });
    expect(restored.verification?.ok).toBe(true);
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("one\n");
    expect(await exists(path.join(workspace, "extra.txt"))).toBe(false);

    const undone = await world.rpc<RestoreOutcome>("undo", { threadId: thread.id });
    expect(undone.restore.kind).toBe("undo");
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("two\n");
    expect(await readFile(path.join(workspace, "extra.txt"), "utf8")).toBe("extra\n");

    const { restores } = await list(world, thread.id);
    expect(restores.map((restore) => [restore.kind, restore.undoneBy !== null])).toEqual([
      ["restore", true],
      ["undo", false],
    ]);
    await expect(world.rpc("undo", { threadId: thread.id, restoreId: restores[0]!.id })).rejects.toThrow(/already undone/u);
  });

  it("leaves bb's chat copies and the thread's own storage out of checkpoints, diffs, and restores", async () => {
    const storage = new Map<string, string>();
    const { world, thread, workspace } = await setup({ storageRoot: (threadId) => storage.get(threadId) ?? path.join(path.sep, "elsewhere", threadId) });
    storage.set(thread.id, path.join(workspace, ".bb-storage", thread.id));
    world.appendEvent(thread.id, "thread/started");
    const chatCopy = path.join(".bb", "chats", thread.id, "thread.json");
    const stored = path.join(".bb-storage", thread.id, "state.json");
    await turn(
      world,
      thread,
      workspace,
      async () => {
        await write(workspace, "scratch.txt", "one\n");
        await write(workspace, chatCopy, "{}\n");
        await write(workspace, stored, "{}\n");
        await write(workspace, ".bb/plugins.json", "{}\n");
      },
      "write one",
    );
    const listed = await list(world, thread.id);
    const [before, after] = ["before-turn", "after-turn"].map((kind) => listed.checkpoints.find((checkpoint) => checkpoint.kind === kind)!);
    expect(after!.changes.map((change) => change.path).sort()).toEqual([".bb/plugins.json", "scratch.txt"]);
    expect(after!.stats).toMatchObject({ files: 2 });
    const snapshotCall = world.hostCalls.find((call) => call.method === "snapshot") as { input: { excludePaths?: string[] } };
    expect(snapshotCall.input.excludePaths).toEqual([path.join(workspace, ".bb-storage", thread.id)]);

    const diff = await world.rpc<{ files: Array<{ path: string }> }>("diff", { threadId: thread.id, from: before!.id, to: "current" });
    expect(diff.files.map((file) => file.path).sort()).toEqual([".bb/plugins.json", "scratch.txt"]);

    await write(workspace, chatCopy, '{"turns":2}\n');
    const preview = await world.rpc<{ plan: { changes: Array<{ path: string; action: string }> } }>("preview", { threadId: thread.id, checkpointId: before!.id });
    expect(preview.plan.changes.map((change) => [change.path, change.action]).sort()).toEqual([
      [".bb/plugins.json", "delete"],
      ["scratch.txt", "write"],
    ]);
    const restored = await world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: before!.id });
    expect(restored.verification?.ok).toBe(true);
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("zero\n");
    expect(await readFile(path.join(workspace, chatCopy), "utf8")).toBe('{"turns":2}\n');
    expect(await readFile(path.join(workspace, stored), "utf8")).toBe("{}\n");
  });

  it("maps a message sent after a restore to the files that restore put back", async () => {
    const { world, thread, workspace } = await setup();
    world.appendEvent(thread.id, "thread/started");
    await turn(world, thread, workspace, () => write(workspace, "scratch.txt", "one\n"), "write one");
    const second = await turn(world, thread, workspace, () => write(workspace, "scratch.txt", "two\n"), "write two");
    const before2 = await world.rpc<{ checkpoint: CheckpointDto }>("resolveMessage", {
      threadId: thread.id,
      message: { role: "user", sourceSeqEnd: second.userSeq },
    });
    await world.rpc("restore", { threadId: thread.id, checkpointId: before2.checkpoint.id });

    // Message 3's own checkpoint fails, so the latest known state before it
    // is what the restore put back, not the end of turn 2.
    world.setBeforeHostCall((method) => {
      if (method === "snapshot") throw new Error("disk unavailable");
    });
    const third = await turn(world, thread, workspace, async () => undefined, "carry on");
    world.setBeforeHostCall(undefined);
    const before3 = await world.rpc<{ match: string; checkpoint: CheckpointDto }>("resolveMessage", {
      threadId: thread.id,
      message: { role: "user", sourceSeqEnd: third.userSeq },
    });
    expect(before3).toMatchObject({ match: "fallback", checkpoint: { id: before2.checkpoint.id } });
  });

  it.skipIf(process.platform === "win32")("keeps Undo for a restore that stopped part way, and undoes it before any older restore", async () => {
    const { world, thread, workspace } = await setup();
    await write(workspace, "locked/b.txt", "b0\n");
    await world.dispatch(thread);
    const base = (await list(world, thread.id)).checkpoints[0]!;
    await write(workspace, "scratch.txt", "one\n");
    const { checkpoint: one } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    await world.rpc("restore", { threadId: thread.id, checkpointId: base.id });
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("zero\n");

    await write(workspace, "scratch.txt", "two\n");
    await write(workspace, "locked/b.txt", "b2\n");
    // A read-only directory: the restore writes scratch.txt, then fails.
    await chmod(path.join(workspace, "locked"), 0o555);
    try {
      await expect(world.rpc("restore", { threadId: thread.id, checkpointId: one.id })).rejects.toThrow(/did not finish[\s\S]*bb rewind undo/u);
      expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("one\n");
      const { restores } = await list(world, thread.id);
      expect(restores.at(-1)).toMatchObject({ kind: "restore", status: "failed", preRestoreCheckpointId: expect.any(String) });

      // Undo takes back the partial restore, not the older finished one.
      const undone = await world.rpc<RestoreOutcome>("undo", { threadId: thread.id });
      expect(undone.verification?.ok).toBe(true);
      expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("two\n");
      expect(await readFile(path.join(workspace, "locked/b.txt"), "utf8")).toBe("b2\n");
    } finally {
      await chmod(path.join(workspace, "locked"), 0o755);
    }
  });

  it("does not offer to undo a restore that failed before changing any file", async () => {
    const { world, thread, workspace } = await setup();
    await world.dispatch(thread);
    const base = (await list(world, thread.id)).checkpoints[0]!;
    await write(workspace, "scratch.txt", "one\n");
    await world.rpc("restore", { threadId: thread.id, checkpointId: base.id });
    await write(workspace, "scratch.txt", "two\n");
    world.setBeforeHostCall((method, input) => {
      if (method === "restore" && (input as { dryRun: boolean }).dryRun === false) throw new Error("host went away");
    });
    await expect(world.rpc("restore", { threadId: thread.id, checkpointId: base.id })).rejects.toThrow(/Nothing was restored: host went away/u);
    world.setBeforeHostCall(undefined);
    const { restores } = await list(world, thread.id);
    expect(restores.map((restore) => [restore.status, restore.preRestoreCheckpointId === null])).toEqual([
      ["ok", false],
      ["failed", true],
    ]);
    // Undo skips the failed attempt and takes back the finished restore.
    await world.rpc("undo", { threadId: thread.id });
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("one\n");
  });

  it("warns in the preview when HEAD moved since the checkpoint", async () => {
    const { world, thread, workspace } = await setup();
    await world.dispatch(thread);
    const checkpoint = (await list(world, thread.id)).checkpoints[0]!;
    await write(workspace, "scratch.txt", "committed change\n");
    userGit(workspace, "commit", "-qam", "agent commit");
    const preview = await world.rpc<{ headMoved: boolean; checkpoint: CheckpointDto }>("preview", { threadId: thread.id, checkpointId: checkpoint.id });
    expect(preview.headMoved).toBe(true);
  });

  it("refuses to restore while the thread or another thread in the workspace runs, and can stop them", async () => {
    const { world, thread, workspace, environment } = await setup();
    await world.dispatch(thread);
    const checkpoint = (await list(world, thread.id)).checkpoints[0]!;
    await write(workspace, "scratch.txt", "changed\n");
    const sibling = world.addThread({ environmentId: environment.id, status: "active", title: "Sibling agent" });

    await expect(world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id })).rejects.toThrow(/running in this workspace: Sibling agent/u);
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("changed\n");

    const cli = await world.harness.behavior.runCli(["restore", checkpoint.id, "--yes", "--thread", thread.id, "--json"]);
    expect(cli.exitCode).not.toBe(0);
    const envelope = JSON.parse(cli.stdout) as { ok: boolean; error: { code: string; hint: string } };
    expect(envelope).toMatchObject({ ok: false, error: { code: "thread_running" } });
    expect(envelope.error.hint).toContain(`bb thread stop ${sibling.id}`);

    thread.status = "active";
    await expect(world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id })).rejects.toThrow(/this thread/u);

    const stopped = await world.rpc<{ stopped: string[] }>("stopRunning", { threadId: thread.id });
    expect(stopped.stopped.sort()).toEqual([sibling.id, thread.id].sort());
    await world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("zero\n");
  });
});

describe("keeping the conversation in step with the files", () => {
  async function twoTurns(options: Parameters<typeof createWorld>[0] = {}) {
    const context = await setup(options);
    const { world, thread, workspace } = context;
    world.appendEvent(thread.id, "thread/started");
    const turn = async (text: string, change: () => Promise<void>) => {
      const userSeq = world.userMessage(thread.id, text);
      await world.dispatch(world.threads.get(thread.id)!, { input: { text, blocks: [] } });
      await change();
      world.assistantMessage(thread.id, `done: ${text}`);
      await world.harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: thread.environmentId }),
        lastAssistantText: "done",
      });
      return userSeq;
    };
    const first = await turn("write one", () => write(workspace, "scratch.txt", "one\n"));
    const second = await turn("write two and extra", async () => {
      await write(workspace, "scratch.txt", "two\n");
      await write(workspace, "extra.txt", "extra\n");
    });
    return { ...context, first, second, turn };
  }

  it("restores the files, then has bb replace the message; the edit goes out only once the files are back", async () => {
    const seen: Array<{ scratch: string; extra: boolean; decision: unknown }> = [];
    let world!: World;
    let threadId = "";
    let workspacePath = "";
    const context = await twoTurns({
      onEditMessage: async () => {
        // bb dispatches the edited message: it must find the files restored
        // and pass the gate without being queued behind a restore.
        seen.push({
          scratch: await readFile(path.join(workspacePath, "scratch.txt"), "utf8"),
          extra: await exists(path.join(workspacePath, "extra.txt")),
          decision: await world.dispatch(world.threads.get(threadId)!, { input: { text: "write three instead", blocks: [] } }),
        });
      },
    });
    world = context.world;
    threadId = context.thread.id;
    workspacePath = context.workspace;

    const resolved = await world.rpc<{ message: { number: number; text: string; editable: boolean } | null }>("resolveMessage", {
      threadId,
      message: { role: "user", sourceSeqEnd: context.second },
    });
    expect(resolved.message).toEqual({ number: 2, text: "write two and extra", editable: true });

    const result = await world.rpc<{ outcome: RestoreOutcome; edit: { ok: boolean; message: number } }>("editMessage", {
      threadId,
      sourceSeqEnd: context.second,
      text: "write three instead",
    });
    expect(result.edit).toMatchObject({ ok: true, message: 2 });
    expect(result.outcome.note).toBeNull();
    expect(result.outcome.preRestore).not.toBeNull();
    expect(world.edits).toEqual([
      expect.objectContaining({ threadId, expectedRequestSequence: context.second, input: [{ type: "text", text: "write three instead", mentions: [] }] }),
    ]);
    expect(seen).toEqual([{ scratch: "one\n", extra: false, decision: { action: "proceed" } }]);
    expect((await world.rpc<{ note: unknown }>("note", { threadId })).note).toBeNull();

    // The edited message is the thread's message 2 now, and "Rewind to here"
    // on it finds a checkpoint of the restored files taken just before it.
    const replaced = await world.rpc<{ match: string; checkpoint: CheckpointDto; message: { number: number; text: string } }>("resolveMessage", {
      threadId,
      message: { role: "user", sourceSeqEnd: (result.edit as unknown as { requestSequence: number }).requestSequence },
    });
    expect(replaced).toMatchObject({ match: "exact", message: { number: 2, text: "write three instead" }, checkpoint: { kind: "before-turn", messageExcerpt: "write three instead" } });
    const same = await world.rpc<{ totalFiles: number }>("diff", { threadId, from: result.outcome.restore.targetCheckpointId, to: replaced.checkpoint.id });
    expect(same.totalFiles).toBe(0);
  });

  it("keeps the restore and offers a note when bb refuses the edit", async () => {
    const { world, thread, workspace, second } = await twoTurns({
      onEditMessage: () => {
        throw new Error("This provider cannot edit messages");
      },
    });
    const result = await world.rpc<{ outcome: RestoreOutcome; edit: { ok: boolean; error: string } }>("editMessage", {
      threadId: thread.id,
      sourceSeqEnd: second,
      text: "write three instead",
    });
    expect(result.edit).toMatchObject({ ok: false, error: expect.stringContaining("cannot edit messages") });
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("one\n");
    // No message followed, so no before-turn checkpoint for one is kept.
    expect((await list(world, thread.id)).checkpoints.filter((checkpoint) => checkpoint.messageExcerpt === "write three instead")).toEqual([]);
    const note = "Files were restored to before message 2 (“write two and extra”); turn 2 was undone. Re-read files before editing.";
    expect(result.outcome.note).toBe(note);
    expect((await world.rpc<{ note: { text: string } | null }>("note", { threadId: thread.id })).note?.text).toBe(note);
    expect(await world.rpc("dismissNote", { threadId: thread.id })).toEqual({ dismissed: true });
    expect((await world.rpc<{ note: unknown }>("note", { threadId: thread.id })).note).toBeNull();
  });

  it("suggests a note after a plain restore, and drops it on undo or when the user sends their next message", async () => {
    const context = await twoTurns();
    const { world, thread, workspace, first, turn } = context;
    await turn("write three", () => write(workspace, "scratch.txt", "three\n"));
    const before1 = await world.rpc<{ checkpoint: CheckpointDto }>("resolveMessage", { threadId: thread.id, message: { role: "user", sourceSeqEnd: first } });
    const restored = await world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: before1.checkpoint.id });
    expect(restored.note).toBe("Files were restored to before message 1 (“write one”); turns 1–3 were undone. Re-read files before editing.");

    await world.rpc("undo", { threadId: thread.id });
    expect((await world.rpc<{ note: unknown }>("note", { threadId: thread.id })).note).toBeNull();

    // To the end of turn 2: only turn 3 is undone.
    const list2 = await list(world, thread.id);
    const after2 = list2.checkpoints.filter((checkpoint) => checkpoint.kind === "after-turn")[1]!;
    const again = await world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: after2.id });
    expect(again.note).toBe("Files were restored to the end of turn 2; turn 3 was undone. Re-read files before editing.");
    // An agent's message does not count; the user's next message does.
    await world.dispatch(thread, { initiator: "agent" });
    expect((await world.rpc<{ note: unknown }>("note", { threadId: thread.id })).note).not.toBeNull();
    await world.dispatch(thread, { initiator: "user", input: { text: "carry on", blocks: [] } });
    expect((await world.rpc<{ note: unknown }>("note", { threadId: thread.id })).note).toBeNull();
  });

  it("does not offer the edit when the thread's provider cannot replace a message", async () => {
    const { world, thread, second } = await twoTurns();
    const byProvider = async (providerId: string) => {
      world.threads.get(thread.id)!.providerId = providerId;
      return world.rpc<{ message: { editable: boolean } | null }>("resolveMessage", { threadId: thread.id, message: { role: "user", sourceSeqEnd: second } });
    };
    expect((await byProvider("codex")).message?.editable).toBe(true);
    await delay(0);
    expect((await byProvider("acp-cursor")).message?.editable).toBe(false);
  });

  it("edits only messages a person typed that started a turn, and restores nothing otherwise", async () => {
    const { world, thread, workspace } = await twoTurns();
    await expect(world.rpc("editMessage", { threadId: thread.id, sourceSeqEnd: 999, text: "x" })).rejects.toThrow(/no message that started a turn/u);

    // Another thread's message (bb refuses to edit those), and a steer that joined its turn.
    const sent = world.userMessage(thread.id, "from another thread", { initiator: "agent" });
    const steer = world.userMessage(thread.id, "and also this", { turnId: `turn_${sent}` });
    const resolved = await world.rpc<{ message: { editable: boolean } | null }>("resolveMessage", { threadId: thread.id, message: { role: "user", sourceSeqEnd: sent } });
    expect(resolved.message?.editable).toBe(false);
    await expect(world.rpc("editMessage", { threadId: thread.id, sourceSeqEnd: sent, text: "x" })).rejects.toThrow(/bb edits only messages you typed\. Nothing was restored/u);
    await expect(world.rpc("editMessage", { threadId: thread.id, sourceSeqEnd: steer, text: "x" })).rejects.toThrow(/no message that started a turn/u);
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("two\n");
    expect(world.edits).toHaveLength(0);
  });

  it("does it from the CLI: dry run, apply, and the note after a plain restore", async () => {
    const { world, thread, second } = await twoTurns();
    const before2 = await world.rpc<{ checkpoint: CheckpointDto }>("resolveMessage", { threadId: thread.id, message: { role: "user", sourceSeqEnd: second } });
    const id = before2.checkpoint.id;
    const dry = await world.harness.behavior.runCli(["restore", id, "--dry-run", "--edit-message", "write three", "--thread", thread.id]);
    expect(dry.stdout).toContain("With --yes this then replaces message 2 (“write two and extra”)");

    const applied = await world.harness.behavior.runCli(["restore", id, "--yes", "--edit-message", "write three", "--thread", thread.id]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("Replaced message 2: bb discarded it and every later turn");
    expect(world.edits).toHaveLength(1);

    const plain = await world.harness.behavior.runCli(["restore", id, "--yes", "--thread", thread.id]);
    expect(plain.stdout).toContain("Suggested note for your next message:");
    expect(plain.stdout).toContain("Files were restored to before message 2");

    const wrong = await world.harness.behavior.runCli(["restore", (await list(world, thread.id)).checkpoints.find((checkpoint) => checkpoint.kind === "after-turn")!.id, "--yes", "--edit-message", "x", "--thread", thread.id, "--json"]);
    expect(JSON.parse(wrong.stdout)).toMatchObject({ ok: false, error: { code: "not_a_message_checkpoint" } });
  });
});

describe("what a restore cannot undo", () => {
  async function turnThatPushes(options: Parameters<typeof createWorld>[0] = {}) {
    const context = await setup(options);
    const { world, thread, workspace } = context;
    world.appendEvent(thread.id, "thread/started");
    const turn = async (text: string, run: () => Promise<void>) => {
      const userSeq = world.userMessage(thread.id, text);
      await world.dispatch(world.threads.get(thread.id)!, { input: { text, blocks: [] } });
      await run();
      world.assistantMessage(thread.id, `done: ${text}`);
      await world.harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: thread.environmentId }),
        lastAssistantText: "done",
      });
      return userSeq;
    };
    const first = await turn("write one", () => write(workspace, "scratch.txt", "one\n"));
    const second = await turn("ship it", async () => {
      world.command(thread.id, 'echo "git push"');
      world.command(thread.id, "/bin/zsh -lc \"git push origin main\"", workspace);
      world.command(thread.id, "git push --help");
      await write(workspace, "scratch.txt", "two\n");
    });
    return { ...context, first, second };
  }

  async function effectsOf(world: World, threadId: string, kind: string, index: number) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = (await list(world, threadId)).checkpoints.filter((checkpoint) => checkpoint.kind === kind)[index];
      if (row?.effects !== null && row?.effects !== undefined) return row;
      await delay(20);
    }
    throw new Error("effects never scanned");
  }

  it("records a turn's commands that reach outside the workspace, and says so wherever a restore undoes that turn", async () => {
    const { world, thread, second } = await turnThatPushes();
    const after2 = await effectsOf(world, thread.id, "after-turn", 1);
    expect(after2.effects).toEqual([{ kind: "git-push", label: "git push", command: "git push origin main" }]);
    const after1 = await effectsOf(world, thread.id, "after-turn", 0);
    expect(after1.effects).toEqual([]);

    const before2 = await world.rpc<{ checkpoint: CheckpointDto }>("resolveMessage", { threadId: thread.id, message: { role: "user", sourceSeqEnd: second } });
    const preview = await world.rpc<{ effects: Array<{ label: string; turn: number | null }> }>("preview", { threadId: thread.id, checkpointId: before2.checkpoint.id });
    expect(preview.effects).toEqual([expect.objectContaining({ label: "git push", turn: 2 })]);

    const dry = await world.harness.behavior.runCli(["restore", before2.checkpoint.id, "--dry-run", "--thread", thread.id]);
    expect(dry.stdout).toContain("Outside the workspace: Turn 2 ran `git push`. Rewind can't undo that.");
    const show = await world.harness.behavior.runCli(["show", after2.id, "--thread", thread.id]);
    expect(show.stdout).toContain("Since the previous checkpoint, the agent ran `git push`; Rewind can't undo that.");

    const outcome = await world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: before2.checkpoint.id });
    expect(outcome.effects).toEqual([expect.objectContaining({ label: "git push", turn: 2 })]);
  });

  it("includes commands run since the latest checkpoint", async () => {
    const { world, thread, workspace, first } = await turnThatPushes();
    world.command(thread.id, "npm publish --access public", workspace);
    const before1 = await world.rpc<{ checkpoint: CheckpointDto }>("resolveMessage", { threadId: thread.id, message: { role: "user", sourceSeqEnd: first } });
    const preview = await world.rpc<{ effects: Array<{ label: string; turn: number | null }> }>("preview", { threadId: thread.id, checkpointId: before1.checkpoint.id });
    expect(preview.effects.map((effect) => [effect.label, effect.turn])).toEqual([
      ["git push", 2],
      ["npm publish", null],
    ]);
  });

  it("filters command events itself when the server rejects the type filter", async () => {
    const { world, thread } = await turnThatPushes({ rejectTypeFilter: true });
    const after2 = await effectsOf(world, thread.id, "after-turn", 1);
    expect(after2.effects?.map((effect) => effect.label)).toEqual(["git push"]);
  });
});

describe("lifecycle events", () => {
  it("takes a baseline when a brand-new thread starts, before its first message", async () => {
    const { world, thread } = await setup();
    const userSeq = world.userMessage(thread.id, "first");
    world.appendEvent(thread.id, "turn/started");
    await world.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: thread.environmentId, status: "active" }),
    });
    const { checkpoints } = await list(world, thread.id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ kind: "before-turn", label: "Thread start", eventMark: 0, status: "ok", late: false });
    const mapped = await world.rpc<{ checkpoint: CheckpointDto }>("resolveMessage", { threadId: thread.id, message: { role: "user", sourceSeqEnd: userSeq } });
    expect(mapped.checkpoint.id).toBe(checkpoints[0]!.id);
  });

  it("flags the baseline late when the agent already ran a tool", async () => {
    const { world, thread } = await setup();
    world.userMessage(thread.id, "first");
    world.appendEvent(thread.id, "turn/started");
    world.appendEvent(thread.id, "item/started", { item: { type: "fileChange" } });
    await world.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: thread.environmentId, status: "active" }),
    });
    expect((await list(world, thread.id)).checkpoints[0]).toMatchObject({ late: true });
  });

  it("does not take a baseline for later turns", async () => {
    const { world, thread } = await setup();
    world.appendEvent(thread.id, "turn/started");
    world.appendEvent(thread.id, "turn/started");
    await world.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: thread.environmentId, status: "active" }),
    });
    expect((await list(world, thread.id)).checkpoints).toHaveLength(0);
  });

  it("takes no after-turn checkpoint when nothing happened since the last one", async () => {
    const { world, thread } = await setup();
    world.appendEvent(thread.id, "thread/started");
    await world.rpc("checkpoint", { threadId: thread.id, label: "fresh" });
    const idle = () =>
      world.harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: thread.environmentId }),
        lastAssistantText: null,
      });
    await idle();
    expect((await list(world, thread.id)).checkpoints.map((checkpoint) => checkpoint.kind)).toEqual(["manual"]);
    world.appendEvent(thread.id, "turn/completed");
    await idle();
    await idle();
    expect((await list(world, thread.id)).checkpoints.map((checkpoint) => checkpoint.kind)).toEqual(["manual", "after-turn"]);
  });

  it("captures a turn's end, flagged late, when the provider started the next turn on its own", async () => {
    const { world, thread, workspace } = await setup();
    world.appendEvent(thread.id, "thread/started");
    await world.dispatch(thread);
    await write(workspace, "scratch.txt", "one\n");
    const ended = world.appendEvent(thread.id, "turn/completed");
    // A wakeup starts the next turn before the idle event is handled. No
    // message was sent, so the gate never ran.
    thread.status = "active";
    world.appendEvent(thread.id, "turn/started");
    await world.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: thread.environmentId }),
      lastAssistantText: null,
    });
    const checkpoints = (await list(world, thread.id)).checkpoints;
    expect(checkpoints.map((checkpoint) => checkpoint.kind)).toEqual(["before-turn", "after-turn"]);
    expect(checkpoints[1]).toMatchObject({ late: true, eventMark: ended, stats: { files: 1 } });
  });

  it("leaves a turn's end to the next message's checkpoint when that message already passed the gate", async () => {
    const { world, thread } = await setup();
    world.appendEvent(thread.id, "thread/started");
    await world.dispatch(thread);
    world.appendEvent(thread.id, "turn/completed");
    // A queued message dispatched the moment the turn ended.
    await world.dispatch(thread);
    thread.status = "active";
    world.appendEvent(thread.id, "turn/started");
    await world.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: thread.environmentId }),
      lastAssistantText: null,
    });
    expect((await list(world, thread.id)).checkpoints.map((checkpoint) => checkpoint.kind)).toEqual(["before-turn", "before-turn"]);
  });

  it("drops a deleted thread's checkpoints and their refs", async () => {
    const { world, thread } = await setup();
    await world.dispatch(thread);
    await world.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: thread.environmentId }),
    });
    expect((await list(world, thread.id)).checkpoints).toHaveLength(0);
    expect(world.hostCalls.some((call) => call.method === "deleteRefs")).toBe(true);
  });
});

describe("retention", () => {
  it("keeps the newest checkpoints per thread and drops archived threads' after the retention period", async () => {
    const { world, thread, workspace, environment } = await setup({ settings: { maxCheckpointsPerThread: 10, retentionDays: 1 } });
    for (let index = 0; index < 12; index += 1) {
      await write(workspace, "scratch.txt", `${index}\n`);
      await world.rpc("checkpoint", { threadId: thread.id, label: `n${index}` });
    }
    const archived = world.addThread({ environmentId: environment.id, archivedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 });
    await world.rpc("checkpoint", { threadId: archived.id });

    const dry = await world.harness.behavior.runCli(["prune", "--dry-run", "--json"]);
    expect(JSON.parse(dry.stdout)).toMatchObject({ deleted: 3, byReason: { "over-limit": 2, archived: 1 } });

    await world.harness.behavior.runSchedule("retention");
    const kept = (await list(world, thread.id)).checkpoints;
    expect(kept.map((checkpoint) => checkpoint.label)).toEqual(["n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11"]);
    expect((await list(world, archived.id)).checkpoints).toHaveLength(0);
    expect(world.hostCalls.filter((call) => call.method === "reconcile")).not.toHaveLength(0);
  });

  it("removes a vanished workspace's store once no checkpoint needs it, and a dry run says so first", async () => {
    const { world, thread, environment } = await setup();
    await world.dispatch(thread);
    const shadows = path.join(world.dataDir, "shadows");
    expect(await readdir(shadows)).toHaveLength(1);

    // The worktree is gone, but the thread's checkpoint still needs the store.
    environment.status = "destroyed";
    expect((await world.harness.behavior.runCli(["prune"])).stdout).toContain("Removed 0 stale refs and 0 unused workspace stores.");
    expect(await readdir(shadows)).toHaveLength(1);

    expect((await world.harness.behavior.runCli(["prune", "--thread", thread.id, "--yes"])).stdout).toContain(`Deleted 1 checkpoint of ${thread.id}.`);
    const dry = await world.harness.behavior.runCli(["prune", "--dry-run"]);
    expect(dry.stdout.trim()).toBe("Would delete 0 checkpoints and remove 1 unused workspace store.");
    expect(await readdir(shadows)).toHaveLength(1);
    expect((await world.harness.behavior.runCli(["prune"])).stdout).toContain("Removed 0 stale refs and 1 unused workspace store.");
    expect(await readdir(shadows)).toHaveLength(0);
  });
});

describe("forking with files", () => {
  it("forks into a new worktree whose files match the checkpoint, then sends the prompt", async () => {
    let forkWorkspace = "";
    const { world, thread, workspace } = await setup({
      onFork: async (_args, fork) => {
        const parent = await tempDir("fork");
        forkWorkspace = path.join(parent, "wt");
        userGit(workspace, "worktree", "add", "-q", "-b", `fork-${fork.id}`, forkWorkspace);
        return { id: `env_fork_${fork.id}`, hostId: "host_test", path: forkWorkspace, status: "ready", isGitRepo: true };
      },
    });
    world.appendEvent(thread.id, "thread/started");
    const userSeq = world.userMessage(thread.id, "write one");
    await world.dispatch(thread);
    await write(workspace, "scratch.txt", "one\n");
    world.assistantMessage(thread.id, "wrote one");
    await world.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: thread.environmentId }),
      lastAssistantText: "wrote one",
    });
    const second = world.userMessage(thread.id, "write two");
    await world.dispatch(thread);
    await write(workspace, "scratch.txt", "two\n");
    void userSeq;

    const target = await world.rpc<{ checkpoint: CheckpointDto }>("resolveMessage", { threadId: thread.id, message: { role: "user", sourceSeqEnd: second } });
    const started = await world.rpc<{ job: { id: string } }>("fork", {
      threadId: thread.id,
      checkpointId: target.checkpoint.id,
      anchorSeq: second,
      prompt: "Try a different approach",
    });
    let job = { status: "running", forkThreadId: null as string | null, error: null as string | null };
    for (let attempt = 0; attempt < 200 && job.status === "running"; attempt += 1) {
      job = (await world.rpc<{ job: typeof job }>("forkStatus", { jobId: started.job.id })).job;
      await delay(50);
    }
    expect(job).toMatchObject({ status: "done", error: null });
    expect(await readFile(path.join(forkWorkspace, "scratch.txt"), "utf8")).toBe("one\n");
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("two\n");
    const forkCall = world.harness.inspection.sdk.callsTo("threads.fork")[0]![0] as Record<string, unknown>;
    expect(forkCall).toMatchObject({ sourceThreadId: thread.id, sourceSeqEnd: second, environment: { type: "host", workspace: { type: "managed-worktree" } } });
    expect(world.sent).toEqual([expect.objectContaining({ threadId: job.forkThreadId, input: [expect.objectContaining({ text: "Try a different approach" })] })]);
    const forkRestores = (await list(world, job.forkThreadId!)).restores;
    expect(forkRestores.map((restore) => restore.kind)).toEqual(["fork"]);
  });
});

describe("the bb rewind CLI", () => {
  it("names the --thread flag when there is no calling thread", async () => {
    const { world } = await setup();
    const result = await world.harness.behavior.runCli(["list"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--thread");
    const json = await world.harness.behavior.runCli(["list", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error: { code: "missing_thread" } });
  });

  it("prints help, suggests options, and requires --yes to restore", async () => {
    const { world, thread } = await setup();
    const help = await world.harness.behavior.runCli(["restore", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--dry-run");
    const typo = await world.harness.behavior.runCli(["restore", "ck_x", "--dri-run"], { threadId: thread.id });
    expect(typo.stderr).toMatch(/unknown option '--dri-run'.*--dry-run/su);
    await world.dispatch(thread);
    const checkpoint = (await list(world, thread.id)).checkpoints[0]!;
    const unconfirmed = await world.harness.behavior.runCli(["restore", checkpoint.id], { threadId: thread.id });
    expect(unconfirmed.exitCode).not.toBe(0);
    expect(unconfirmed.stderr).toContain("--yes");
    const both = await world.harness.behavior.runCli(["restore", checkpoint.id, "--yes", "--dry-run"], { threadId: thread.id });
    expect(both.exitCode).not.toBe(0);
  });

  it("lists, shows, diffs, restores, and undoes from the command line", async () => {
    const { world, thread, workspace } = await setup();
    world.userMessage(thread.id, "change scratch");
    await world.dispatch(thread);
    const first = (await list(world, thread.id)).checkpoints[0]!;
    await write(workspace, "scratch.txt", "changed by the agent\n");
    world.assistantMessage(thread.id, "changed");
    await world.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: thread.id, projectId: "proj_test", environmentId: thread.environmentId }),
      lastAssistantText: null,
    });
    const ctx = { threadId: thread.id };
    const listed = await world.harness.behavior.runCli(["list"], ctx);
    expect(listed.stdout).toContain(first.id);
    expect(listed.stdout).toContain("after turn");
    const after = (await list(world, thread.id)).checkpoints.at(-1)!;
    const shown = await world.harness.behavior.runCli(["show", after.id.slice(0, 12)], ctx);
    expect(shown.stdout).toContain("M scratch.txt");
    const stat = await world.harness.behavior.runCli(["diff", after.id, "--stat"], ctx);
    expect(stat.stdout).toContain("scratch.txt");
    expect(stat.stdout).toContain("1 file changed");
    const patch = await world.harness.behavior.runCli(["diff", after.id], ctx);
    expect(patch.stdout).toContain("+changed by the agent");
    const dry = await world.harness.behavior.runCli(["restore", first.id, "--dry-run"], ctx);
    expect(dry.stdout).toContain("Nothing was changed");
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("changed by the agent\n");
    const applied = await world.harness.behavior.runCli(["restore", first.id, "--yes"], ctx);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("Verified");
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("zero\n");
    const undo = await world.harness.behavior.runCli(["undo", "--yes"], ctx);
    expect(undo.exitCode).toBe(0);
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("changed by the agent\n");
    const status = await world.harness.behavior.runCli(["status", "--json"], ctx);
    expect(JSON.parse(status.stdout)).toMatchObject({ thread: { threadId: thread.id } });
    const checkpoint = await world.harness.behavior.runCli(["checkpoint", "--label", "before the risky bit"], ctx);
    expect(checkpoint.stdout).toMatch(/Checkpoint ck_[a-z0-9]+ taken/u);
  });
});

describe("agent tools", () => {
  it("checkpoints and lists for the calling thread", async () => {
    const { world, thread } = await setup();
    const saved = await world.harness.behavior.callAgentTool("rewind_checkpoint", { label: "before codemod" }, { threadId: thread.id });
    expect(String(saved)).toMatch(/Checkpoint ck_[a-z0-9]+ saved/u);
    const listed = await world.harness.behavior.callAgentTool("rewind_list", { limit: 5 }, { threadId: thread.id });
    expect(String(listed)).toContain("before codemod");
    expect(world.harness.inspection.registrations.agentTools.map((tool) => tool.name).sort()).toEqual(["rewind_checkpoint", "rewind_list"]);
  });
});

describe("an agent inside its own turn", () => {
  it("is told to hand the restore to the user instead of stopping itself", async () => {
    const { world, thread } = await setup();
    await world.dispatch(thread);
    const checkpoint = (await list(world, thread.id)).checkpoints[0]!;
    thread.status = "active";
    const result = await world.harness.behavior.runCli(["restore", checkpoint.id, "--yes", "--stop-running", "--json"], { threadId: thread.id });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "thread_running" } });
    expect(JSON.parse(result.stdout).error.hint).toContain("Checkpoints panel");
    expect(thread.status).toBe("active");
    const preview = await world.harness.behavior.runCli(["restore", checkpoint.id, "--dry-run"], { threadId: thread.id });
    expect(preview.exitCode).toBe(0);
  });
});
