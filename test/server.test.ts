// Server behaviour through the SDK's fake plugin host, with host RPC running
// the real host handlers (real git) against temp directories.
import { chmod, readdir, readFile, symlink } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server";
import { GATE_HARD_LIMIT_MS } from "../src/constants";
import { resetGitBaseEnv } from "../src/host/git";
import { clearUserRepoCaches } from "../src/host/user-repo";
import type { CheckpointDto, RestoreOutcome, WorkspaceInfo } from "../src/rpc-contract";
import { exists, initRepo, removeTempDirs, tempDir, userGit, write } from "./helpers/fs";
import { createWorld, queuedRow, type World } from "./helpers/world";

const worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.harness.lifecycle.dispose();
  vi.restoreAllMocks();
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

describe("review safety regressions", () => {
  it.each(["alias", "distinct"])("F01 rechecks restore ownership after a completed snapshot response (%s)", async workspaceKind => {
    const { world, thread, workspace } = await setup();
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    await write(workspace, "scratch.txt", "before restore\n");
    const siblingWorkspace = workspaceKind === "alias" ? path.join(await tempDir("alias"), "linked") : await tempDir("distinct");
    if (workspaceKind === "alias") await symlink(workspace, siblingWorkspace, "dir");
    else await initRepo(siblingWorkspace, { "scratch.txt": "distinct\n" });
    const sibling = world.addThread({ environmentId: world.addEnvironment(siblingWorkspace).id });
    let snapshotReady!: () => void, releaseSnapshot!: () => void, restoreReady!: () => void, releaseRestore!: () => void;
    const snapshotted = new Promise<void>(resolve => { snapshotReady = resolve; });
    const snapshotBarrier = new Promise<void>(resolve => { releaseSnapshot = resolve; });
    const restoring = new Promise<void>(resolve => { restoreReady = resolve; });
    const restoreBarrier = new Promise<void>(resolve => { releaseRestore = resolve; });
    world.setAfterHostCall(async (method, input) => {
      if (method === "snapshot" && (input as { workspace: string }).workspace === siblingWorkspace) { snapshotReady(); await snapshotBarrier; }
    });
    world.setBeforeHostCall(async (method, input) => {
      if (method === "restore" && !(input as { dryRun: boolean }).dryRun) { restoreReady(); await restoreBarrier; }
    });
    // Timer delivery is held, not filesystem work: snapshot completion and the
    // destructive call are deterministic barriers rather than wall-clock races.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dispatch = world.dispatch(sibling);
    let pending: Promise<RestoreOutcome> | undefined;
    try {
      await snapshotted;
      pending = world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: checkpoint.id });
      await restoring;
      releaseSnapshot();
      const decision = await dispatch;
      if (decision.action === "proceed") {
        // Model the ordinary agent turn that core is now allowed to start.
        sibling.status = "active";
        await write(siblingWorkspace, "scratch.txt", "ordinary agent bytes\n");
      }
      expect(decision).toEqual(workspaceKind === "alias" ? { action: "wait", reason: "Rewind: restoring files…", sendAt: expect.any(Number) } : { action: "proceed" });
    } finally {
      vi.useRealTimers(); releaseSnapshot(); releaseRestore(); await dispatch; await pending;
      world.setAfterHostCall(undefined); world.setBeforeHostCall(undefined);
    }
    expect(await readFile(path.join(siblingWorkspace, "scratch.txt"), "utf8")).toBe(workspaceKind === "alias" ? "zero\n" : "ordinary agent bytes\n");
    if (workspaceKind === "alias") expect(await world.dispatch(sibling)).toEqual({ action: "proceed" });
  });
  it.each([true, false])("F01 keeps a stalled-identity dispatch queued past the server hard timeout (enabled=%s)", async enabled => {
    const { world, thread, workspace } = await setup();
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    const alias = path.join(await tempDir("alias"), "linked"); await symlink(workspace, alias, "dir");
    const sibling = world.addThread({ environmentId: world.addEnvironment(alias).id });
    await world.harness.behavior.setSettings({ enabled });
    let entered!: () => void, releaseRestore!: () => void, identified!: () => void, releaseIdentity!: () => void;
    const restoring = new Promise<void>(r => { entered = r; }), restoreBarrier = new Promise<void>(r => { releaseRestore = r; });
    const identifying = new Promise<void>(r => { identified = r; }), identityBarrier = new Promise<void>(r => { releaseIdentity = r; });
    world.setBeforeHostCall(async (method, input) => {
      if (method === "restore" && !(input as { dryRun: boolean }).dryRun) { entered(); await restoreBarrier; }
    });
    const pending = world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    await restoring;
    world.setBeforeHostCall(async method => { if (method === "identity") { identified(); await identityBarrier; } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dispatch = world.dispatch(sibling);
    try {
      await identifying;
      await vi.advanceTimersByTimeAsync(GATE_HARD_LIMIT_MS);
      expect(await dispatch).toMatchObject({ action: "wait", reason: "Rewind: restoring files…" });
      // A failed identity is equally uncertain; it must not authorize the sibling.
      world.setBeforeHostCall(method => { if (method === "identity") throw new Error("identity unavailable"); });
      expect(await world.dispatch(sibling)).toMatchObject({ action: "wait", reason: "Rewind: restoring files…" });
      await world.harness.behavior.emitThreadEvent("message.queued", { entry: queuedRow(sibling.id, { waitingOn: { kind: "plugin", pluginId: "rewind", reason: "Rewind: restoring files…" } }) });
    } finally {
      vi.useRealTimers(); world.setBeforeHostCall(undefined); releaseIdentity(); releaseRestore(); await dispatch; await pending;
    }
    // The timeout fallback must retain wait bookkeeping so completion requests a retry.
    await until(() => world.harness.inspection.recheckCount > 1);
    expect(await world.dispatch(sibling)).toEqual({ action: "proceed" });
  });
  it("F14 fails open dispatch with a clearly failed checkpoint on an oversized real ignore source", async () => {
    const home = await tempDir("ignore-home"); await write(home, ".config/git/ignore", "#".repeat(1024 * 1024 + 10) + "\n*.secret\n");
    const previousHome = process.env.HOME, previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home; process.env.XDG_CONFIG_HOME = path.join(home, ".config"); resetGitBaseEnv();
    try {
      const { world, thread } = await setup(); await world.harness.behavior.setSettings({ gateHoldMs: 1000 });
      expect(await world.dispatch(thread)).toEqual({ action: "proceed" });
      const captured = await list(world, thread.id);
      expect(captured.checkpoints.at(-1)).toMatchObject({ status: "failed", error: expect.stringMatching(/ignore source.*exceeds/u) });
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
      resetGitBaseEnv();
    }
  });
  it("F02 agrees across preview restore Undo and stop for runtime-only active self at row 201", async () => {
    const { world, thread, workspace } = await setup();
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    await world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    for (let i = 0; i < 200; i++) world.addThread({ environmentId: thread.environmentId });
    world.threads.delete(thread.id); world.threads.set(thread.id, thread); thread.runtimeStatus = "starting";
    expect((await world.rpc<{ workspace: WorkspaceInfo }>("preview", { threadId: thread.id, checkpointId: checkpoint.id })).workspace.running).toContainEqual(expect.objectContaining({ id: thread.id, status: "starting", isSelf: true }));
    await expect(world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id })).rejects.toThrow(/running|working/u);
    await expect(world.rpc("undo", { threadId: thread.id })).rejects.toThrow(/running|working/u);
    const stopped = await world.rpc<{ stopped: string[] }>("stopRunning", { threadId: thread.id });
    expect(stopped.stopped).toContain(thread.id);
    expect((await world.rpc<{ workspace: WorkspaceInfo }>("preview", { threadId: thread.id, checkpointId: checkpoint.id })).workspace.running).toEqual([]);
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("zero\n");
  });
  it("U02 persists uncertain identity before a delayed restore response and survives server reload", async () => {
    const { world, thread, workspace } = await setup();
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    await write(workspace, "scratch.txt", "before interrupted reply\n");
    let entered!: () => void, release!: () => void;
    const written = new Promise<void>(r => { entered = r; }), response = new Promise<void>(r => { release = r; });
    world.setAfterHostCall(async (method, input) => {
      if (method === "restore" && !(input as { dryRun: boolean }).dryRun) { entered(); await response; throw new Error("lost delayed response"); }
    });
    const pending = world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id }).catch(error => error);
    await written; expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("zero\n");
    const reloaded = await world.harness.lifecycle.reload(plugin);
    try {
      const listed = await reloaded.harness.behavior.callRpc("list", { threadId: thread.id }) as ListResult;
      expect(listed.restores.at(-1)?.preRestoreCheckpointId).toBeTruthy();
      world.setAfterHostCall(undefined); release(); await pending;
      await reloaded.harness.behavior.callRpc("undo", { threadId: thread.id });
      expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("before interrupted reply\n");
    } finally { release(); await pending; await reloaded.harness.lifecycle.dispose(); }
  });
  it("F12 fails the bounded timeline search before any fork or prompt is sent", async () => {
    const { world, thread } = await setup();
    world.userMessage(thread.id, "old checkpoint without a reply");
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    for (let i = 0; i < 3100; i++) world.userMessage(thread.id, `later ${i}`);
    const result = await world.harness.behavior.runCli(["fork", checkpoint.id, "--thread", thread.id]);
    expect(result.exitCode).toBe(1); expect(result.stderr + result.stdout).toMatch(/exceeds 30 timeline pages/u);
    expect(world.harness.inspection.sdk.callsTo("threads.fork")).toHaveLength(0); expect(world.sent).toHaveLength(0);
  });
  it("F03 preserves offered workspace Undo even after the owner is archived", async () => {
    const { world, thread, environment, workspace } = await setup();
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    await write(workspace, "scratch.txt", "archived owner original\n");
    const restored = await world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    thread.archivedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const sibling = world.addThread({ environmentId: environment.id });
    await world.harness.behavior.runSchedule("retention");
    expect((await list(world, thread.id)).checkpoints.map(c => c.id)).toContain(restored.preRestore!.id);
    await world.rpc("undo", { threadId: sibling.id });
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("archived owner original\n");
  });
  it("F01 preserves historical refs and workspace Undo through a symlink environment", async () => {
    const { world, thread, workspace } = await setup();
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    await write(workspace, "scratch.txt", "before alias Undo\n");
    await world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    const alias = path.join(await tempDir("alias"), "linked"); await symlink(workspace, alias, "dir");
    const sibling = world.addThread({ environmentId: world.addEnvironment(alias).id });
    expect(await world.rpc("diff", { threadId: sibling.id, from: checkpoint.id, to: "current" })).toMatchObject({ totalFiles: 0 });
    await world.rpc("undo", { threadId: sibling.id });
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("before alias Undo\n");
    expect((await list(world, thread.id)).checkpoints.find(c => c.id === checkpoint.id)?.workspace).toBe(workspace);
  });
  it("F13 continues full raw event pages with no locally matching commands", async () => {
    const { world, thread } = await setup({ rejectTypeFilter: true });
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    for (let i = 0; i < 100; i++) world.appendEvent(thread.id, "unrelated/event");
    world.command(thread.id, "git push origin main");
    const preview = await world.rpc<{ effects: Array<{ label: string }> }>("preview", { threadId: thread.id, checkpointId: checkpoint.id });
    expect(preview.effects.map(e => e.label)).toContain("git push");
    expect(world.harness.inspection.sdk.callsTo("threads.events.list").filter(c => (c[0] as { afterSeq?: string }).afterSeq === "100").length).toBeGreaterThan(0);
    const { checkpoint: newer } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    const cached = await world.rpc<{ effects: Array<{ label: string }> }>("preview", { threadId: thread.id, checkpointId: checkpoint.id }); expect(cached.effects.map(e => e.label)).toContain("git push");
    expect((await list(world, thread.id)).checkpoints.find(c => c.id === newer.id)?.effects?.map(e => e.label)).toContain("git push");
    const shown = await world.harness.behavior.runCli(["show", newer.id], { threadId: thread.id }); expect(shown.stdout).toContain("git push");
    const restored = await world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: checkpoint.id }); expect(restored.effects.map(e => e.label)).toContain("git push");
  });
  it.each(["before-turn", "after-turn", "manual"])("F12 pages old %s fork boundaries before creating a fork", async kind => {
    let forked!: (args: Record<string, unknown>) => void;
    const observed = new Promise<Record<string, unknown>>(r => { forked = r; });
    const target = await tempDir("fork-target"); await initRepo(target, { "scratch.txt": "target\n" });
    const { world, thread } = await setup({ onFork: async args => {
      forked(args); return { id: "env_fork", hostId: "host_test", path: target, status: "ready", isGitRepo: true };
    } });
    const user = world.userMessage(thread.id, "old turn"); await world.dispatch(thread);
    const reply = world.assistantMessage(thread.id, "old reply");
    await world.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: thread.id, projectId: thread.projectId, environmentId: thread.environmentId }), lastAssistantText: "old reply" });
    if (kind === "manual") await world.rpc("checkpoint", { threadId: thread.id });
    const checkpoint = (await list(world, thread.id)).checkpoints.find(c => c.kind === kind)!;
    const anchor = kind === "before-turn" ? user : reply;
    for (let i = 0; i < 60; i++) { world.userMessage(thread.id, `new ${i}`); world.assistantMessage(thread.id, `reply ${i}`); }
    await world.rpc("fork", { threadId: thread.id, checkpointId: checkpoint.id });
    expect((await observed).sourceSeqEnd).toBe(anchor);
  });
  it("F03 retains the Undo selected after a newer no-write failure", async () => {
    const { world, thread, workspace } = await setup({ settings: { maxCheckpointsPerThread: 10 } });
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    await write(workspace, "scratch.txt", "must survive retention\n");
    const success = await world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    world.setBeforeHostCall(method => { if (method === "restore") throw new Error("authoritative no-write failure"); });
    await expect(world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id })).rejects.toThrow(/Nothing was restored/u);
    world.setBeforeHostCall(undefined);
    for (let i = 0; i < 12; i++) await world.rpc("checkpoint", { threadId: thread.id });
    await world.harness.behavior.runSchedule("retention");
    expect((await list(world, thread.id)).checkpoints.map(c => c.id)).toContain(success.preRestore!.id);
    await world.rpc("undo", { threadId: thread.id });
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("must survive retention\n");
  });
  it("U02 preserves real-write Undo identity when recovery hits filesystem EACCES and reconnects after reload", async () => {
    const { world, thread, workspace } = await setup();
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    const older = await world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    await write(workspace, "scratch.txt", "before inaccessible recovery\n");
    const realLstat = fsPromises.lstat;
    let denied: { mockRestore(): void } | undefined;
    world.setAfterHostCall((method, input) => {
      if (method === "restore" && !(input as { dryRun: boolean }).dryRun) {
        denied = vi.spyOn(fsPromises, "lstat").mockImplementation((async (...args: Parameters<typeof realLstat>) => {
          if (String(args[0]).startsWith(path.join(world.dataDir, "shadows"))) throw Object.assign(new Error("shadow store EACCES"), { code: "EACCES" });
          return realLstat(...args);
        }) as typeof realLstat); syncBuiltinESMExports();
        throw new Error("lost response after writing test files");
      }
    });
    try {
      await expect(world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id })).rejects.toThrow(/files may have changed/u);
      expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("zero\n");
      const uncertain = (await list(world, thread.id)).restores.at(-1)!;
      expect(uncertain.preRestoreCheckpointId).toBeTruthy();
      await expect(world.rpc("undo", { threadId: thread.id, restoreId: older.restore.id })).rejects.toThrow(/latest restore is uncertain/u);
      await expect(world.rpc("undo", { threadId: thread.id })).rejects.toThrow(/EACCES/u);
      const reloaded = await world.harness.lifecycle.reload(plugin);
      try {
        const afterReload = await reloaded.harness.behavior.callRpc("list", { threadId: thread.id }) as ListResult;
        expect(afterReload.restores.at(-1)?.preRestoreCheckpointId).toBe(uncertain.preRestoreCheckpointId);
        await expect(reloaded.harness.behavior.callRpc("undo", { threadId: thread.id })).rejects.toThrow(/EACCES/u);
        world.setAfterHostCall(undefined); denied?.mockRestore(); syncBuiltinESMExports();
        await reloaded.harness.behavior.callRpc("undo", { threadId: thread.id });
        expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("before inaccessible recovery\n");
      } finally { await reloaded.harness.lifecycle.dispose(); }
    } finally { world.setAfterHostCall(undefined); denied?.mockRestore(); syncBuiltinESMExports(); }
  });
  it("U02 recovers an uncertain real-write restore after transport loss and reload", async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { world, thread, workspace } = await setup();
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    const older = await world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    await write(workspace, "scratch.txt", "original before restore\n");
    world.setAfterHostCall((method, input) => {
      if (method === "restore" && !(input as { dryRun: boolean }).dryRun) throw new Error("transport disconnected after writes");
    });
    world.setBeforeHostCall(method => { if (method === "refCommit") throw new Error("host offline"); });
    await expect(world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id })).rejects.toThrow(/files may have changed/u);
    expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("zero\n");
    expect((await list(world, thread.id)).restores.at(-1)?.preRestoreCheckpointId).toBeTruthy();
    await expect(world.rpc("undo", { threadId: thread.id, restoreId: older.restore.id })).rejects.toThrow(/latest restore is uncertain/u);
    await expect(world.rpc("undo", { threadId: thread.id })).rejects.toThrow(/offline/u);
    now += 8 * 24 * 60 * 60 * 1000;
    await world.harness.behavior.runSchedule("retention");
    expect((await list(world, thread.id)).restores.at(-1)?.preRestoreCheckpointId).toBeTruthy();
    world.setAfterHostCall(undefined); world.setBeforeHostCall(undefined);
    const reloaded = await world.harness.lifecycle.reload(plugin);
    try {
      await reloaded.harness.behavior.callRpc("undo", { threadId: thread.id });
      expect(await readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe("original before restore\n");
    } finally { await reloaded.harness.lifecycle.dispose(); clock.mockRestore(); }
  });
  it("F01 shares restore gates and active discovery across environment aliases", async () => {
    const { world, thread, workspace } = await setup();
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    const alias = path.join(await tempDir("alias"), "linked");
    await symlink(workspace, alias, "dir");
    const siblingEnv = world.addEnvironment(alias);
    const sibling = world.addThread({ environmentId: siblingEnv.id, status: "active" });
    await expect(world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id })).rejects.toThrow(/running/u);
    await world.rpc("stopRunning", { threadId: thread.id });
    expect(sibling.status).toBe("idle");
    await world.harness.behavior.setSettings({ enabled: false });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const barrier = new Promise<void>(r => { release = r; });
    world.setBeforeHostCall(async (method, input) => {
      if (method === "restore" && !(input as { dryRun: boolean }).dryRun) { entered(); await barrier; }
    });
    const pending = world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    await started;
    try {
      expect(await world.dispatch(sibling)).toMatchObject({ action: "wait", reason: "Rewind: restoring files…" });
      const distinctEnv = world.addEnvironment(await tempDir("different"));
      expect(await world.dispatch(world.addThread({ environmentId: distinctEnv.id }))).toEqual({ action: "proceed" });
      await expect(world.rpc("restore", { threadId: sibling.id, checkpointId: checkpoint.id })).rejects.toThrow(/already in progress/u);
      sibling.status = "active";
    } finally { release(); await pending; }
    const restored = await pending as RestoreOutcome;
    expect(restored.warnings).toContainEqual(expect.stringContaining(`${sibling.title} started a turn`));
  });
  it("F02 blocks an active sibling at row 201 and fails closed on page errors", async () => {
    const { world, thread, environment } = await setup();
    const { checkpoint } = await world.rpc<{ checkpoint: CheckpointDto }>("checkpoint", { threadId: thread.id });
    for (let i = 0; i < 199; i++) world.addThread({ environmentId: environment.id });
    const active = world.addThread({ environmentId: environment.id, status: "active" });
    await expect(world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id })).rejects.toThrow(/running/u);
    expect((await list(world, thread.id)).workspace?.running.map(t => t.id)).toContain(active.id);
    active.status = "idle"; active.runtimeStatus = "starting";
    await expect(world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id })).rejects.toThrow(/running/u);
    const firstPage = await world.bb.sdk.threads.list({ environmentId: environment.id, limit: 200 });
    world.harness.inspection.sdk.stub("threads.list", async (args: { offset?: number }) => {
      if ((args.offset ?? 0) >= 200) throw new Error("page unavailable");
      return firstPage;
    });
    await expect(world.rpc("restore", { threadId: thread.id, checkpointId: checkpoint.id })).rejects.toThrow(/page unavailable/u);
    expect(world.hostCalls.filter(c => c.method === "restore" && !(c.input as {dryRun: boolean}).dryRun)).toHaveLength(0);
  });
});

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

  it("keeps expired restore waits queued and warns about turns that skipped the queue", async () => {
    const { world, thread, checkpoint, sibling, restoreStarted } = await slowRestoreWorld();
    const restoring = world.rpc<RestoreOutcome>("restore", { threadId: thread.id, checkpointId: checkpoint.id });
    await restoreStarted;
    // A row queued behind this restore longer ago than the cap (rebuilt from its wait).
    const row = queuedRow(sibling.id, {
      createdAt: Date.now() - 21 * 60 * 1000,
      waitingOn: { kind: "plugin", pluginId: "rewind", reason: "Rewind: restoring files…" },
    });
    expect(await world.dispatch(sibling, { queuedMessages: [row] })).toMatchObject({ action: "wait", reason: "Rewind: restoring files…" });
    // Send now skips the hook; the sibling's turn starts during the restore.
    sibling.status = "active";
    const outcome = await restoring;
    expect(outcome.warnings).toEqual([
      expect.stringContaining("Sibling agent started a turn while the files were being restored"),
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
