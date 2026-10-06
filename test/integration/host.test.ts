// Integration tests for the host entry: real git, real temp directories, the
// handlers called through the SDK's host harness (so the contract schemas and
// JSON transport apply exactly as in the daemon).
import { mkdirSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hostEntry from "../../host";
import { newId } from "../../src/ids";
import { resetGitBaseEnv } from "../../src/host/git";
import { activeLockCount } from "../../src/host/lock";
import { shadowKey } from "../../src/host/shadow";
import { clearUserRepoCaches } from "../../src/host/user-repo";
import type { SnapshotLimits } from "../../src/host-contract";
import {
  GIT_TIMEOUT_MS,
  exists,
  fingerprint,
  initRepo,
  link,
  removeTempDirs,
  snapshotTree,
  tempDir,
  treeToObject,
  userGit,
  write,
} from "../helpers/fs";

/** Windows has no POSIX permission bits, and symlinks need a privilege there. */
const POSIX = process.platform !== "win32";

async function until(condition: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const LIMITS: SnapshotLimits = { maxFileBytes: 10 * 1024 * 1024, maxFiles: 100_000, maxTotalBytes: 2 * 1024 * 1024 * 1024 };

type Harness = ReturnType<typeof makeHarness>;
function makeHarness(dataDir: string, tempRoot: string) {
  return experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: tempRoot } });
}

let harness: Harness;
let dataDir: string;

beforeEach(async () => {
  clearUserRepoCaches();
  dataDir = await tempDir("data");
  harness = makeHarness(dataDir, await tempDir("tmp"));
});

afterEach(async () => {
  await harness.experimental_dispose();
  await removeTempDirs();
});

async function snap(workspace: string, options: { limits?: SnapshotLimits; compareTo?: string | null; force?: boolean; excludePaths?: string[] } = {}) {
  const checkpointId = newId("ck");
  const result = await harness.experimental_call("snapshot", {
    workspace,
    checkpointId,
    kind: "manual",
    subject: "test",
    compareTo: options.compareTo ?? null,
    limits: options.limits ?? LIMITS,
    ...(options.excludePaths === undefined ? {} : { excludePaths: options.excludePaths }),
    force: options.force ?? false,
  });
  return { checkpointId, result };
}

async function okSnap(workspace: string, options: { limits?: SnapshotLimits; compareTo?: string | null; excludePaths?: string[] } = {}) {
  const { checkpointId, result } = await snap(workspace, options);
  if (result.status !== "ok") throw new Error(`snapshot not ok: ${JSON.stringify(result)}`);
  return { checkpointId, ...result };
}

async function restore(
  workspace: string,
  target: { checkpointId: string; commit: string },
  options: { dryRun?: boolean; limits?: SnapshotLimits; sourceWorkspace?: string | null } = {},
) {
  const preRestoreId = newId("ck");
  const result = await harness.experimental_call("restore", {
    workspace,
    target: { commit: target.commit, checkpointId: target.checkpointId, sourceWorkspace: options.sourceWorkspace ?? null },
    dryRun: options.dryRun ?? false,
    preRestore: options.dryRun ? null : { checkpointId: preRestoreId, subject: "pre-restore" },
    limits: options.limits ?? LIMITS,
    maxListed: 500,
  });
  if (result.status !== "ok") throw new Error(`restore not ok: ${JSON.stringify(result)}`);
  return { preRestoreId, ...result };
}

function shadowGit(workspace: string, ...args: string[]): string {
  // Test-only peek into the shadow repository.
  const gitDir = path.join(dataDir, "shadows", shadowKey(workspace), "git");
  return execFileSync("git", [`--git-dir=${gitDir}`, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
}

describe("review host regressions", () => {
  it("F01 preserves self-contained historical diffs and imports after the source workspace vanishes", async () => {
    const ws = await tempDir("source"); await write(ws, "a.txt", "one\n"); const first = await okSnap(ws);
    await write(ws, "a.txt", "two\n"); const second = await okSnap(ws);
    await rm(ws, { recursive: true, force: true });
    const diff = await harness.experimental_call("diff", { workspace: ws, from: { kind: "checkpoint", commit: first.commit, checkpointId: first.checkpointId }, to: { kind: "checkpoint", commit: second.commit, checkpointId: second.checkpointId }, paths: null, patch: true, maxFiles: 20, maxPatchBytesPerFile: 10000, maxPatchBytesTotal: 10000, limits: LIMITS });
    expect(diff.status).toBe("ok"); if (diff.status === "ok") expect(diff.files[0]?.patch).toContain("+two");
    const target = await tempDir("target"); await write(target, "a.txt", "three\n");
    expect((await restore(target, second, { sourceWorkspace: ws })).verification?.ok).toBe(true);
    expect(await readFile(path.join(target, "a.txt"), "utf8")).toBe("two\n");
  });
  it("F06 cancelled queued work cannot orphan the still-running workspace lock", async () => {
    const ws = await tempDir("ws"); await write(ws, "a.txt", "one\n"); const old = await okSnap(ws);
    let entered!: () => void, release!: () => void, identity!: () => void;
    const enteredPromise = new Promise<void>(r => { entered = r; }), barrier = new Promise<void>(r => { release = r; });
    const identified = new Promise<void>(r => { identity = r; });
    const read = fsPromises.readFile; let held = false;
    const readSpy = vi.spyOn(fsPromises, "readFile").mockImplementation((async (...args: Parameters<typeof read>) => {
      if (!held && String(args[0]).endsWith("state.json")) { held = true; entered(); await barrier; }
      return read(...args);
    }) as typeof read); syncBuiltinESMExports();
    const saving = snap(ws); await enteredPromise;
    const getStat = fsPromises.stat;
    const statSpy = vi.spyOn(fsPromises, "stat").mockImplementation((async (...args: Parameters<typeof getStat>) => {
      const result = await getStat(...args); if (String(args[0]) === ws) identity(); return result;
    }) as typeof getStat); syncBuiltinESMExports();
    const controller = new AbortController();
    const diff = harness.experimental_call("diff", { workspace: ws, from: { kind: "checkpoint", commit: old.commit, checkpointId: old.checkpointId }, to: { kind: "workspace" }, paths: null, patch: false, maxFiles: 20, maxPatchBytesPerFile: 10000, maxPatchBytesTotal: 10000, limits: LIMITS }, { signal: controller.signal });
    const rejected = expect(diff).rejects.toThrow(/abort|cancel/u);
    try {
      await identified; await new Promise<void>(r => setImmediate(r)); // Admission follows the completed identity I/O, not a wall-clock sleep.
      controller.abort(); await rejected;
      expect(activeLockCount()).toBe(1); // The first snapshot still owns the queue.
    } finally { release(); await saving; readSpy.mockRestore(); statSpy.mockRestore(); syncBuiltinESMExports(); }
    expect((await okSnap(ws)).deduped).toBe(true);
  });
  it("F01 never captures an in-workspace shadow store through an alias", async () => {
    const ws = await tempDir("ws"); await write(ws, "a.txt", "one\n");
    await harness.experimental_dispose(); dataDir = path.join(ws, "rewind-data"); harness = makeHarness(dataDir, await tempDir("tmp"));
    const alias = path.join(await tempDir("alias"), "linked"); await symlink(ws, alias, "dir");
    const captured = await okSnap(alias);
    expect(shadowGit(alias, "ls-tree", "-r", "--name-only", captured.commit).trim().split("\n")).toEqual(["a.txt"]);
  });
  it("F01 preserves configured chat-storage protection through workspace aliases", async () => {
    const ws = await tempDir("ws"); await write(ws, "a.txt", "one\n"); await write(ws, "thread-store/chat.json", "old chat\n");
    const old = await okSnap(ws);
    const alias = path.join(await tempDir("alias"), "linked"); await symlink(ws, alias, "dir");
    const storage = path.join(ws, "thread-store"); await write(ws, "thread-store/chat.json", "new chat\n");
    const captured = await okSnap(alias, { excludePaths: [storage] });
    expect(shadowGit(alias, "ls-tree", "-r", "--name-only", captured.commit)).not.toContain("thread-store/");
    await restore(alias, old, { sourceWorkspace: ws });
    expect(await readFile(path.join(ws, "thread-store/chat.json"), "utf8")).toBe("new chat\n");
  });
  it("F08 rejects expired, wrong-workspace and cold-worker handles and releases pins", async () => {
    const ws = await tempDir("ws"), other = await tempDir("other");
    await write(ws, "a.txt", "one\n"); const old = await okSnap(ws); await write(ws, "a.txt", "two\n");
    const input = { workspace: ws, from: { kind: "checkpoint" as const, commit: old.commit, checkpointId: old.checkpointId }, to: { kind: "workspace" as const }, paths: null, patch: false, maxFiles: 20, maxPatchBytesPerFile: 10000, maxPatchBytesTotal: 10000, limits: LIMITS };
    const listed = await harness.experimental_call("diff", input);
    if (listed.status !== "ok" || listed.comparison === undefined) throw new Error("No comparison handle");
    expect(await harness.experimental_call("diff", { ...input, workspace: other, comparison: listed.comparison })).toMatchObject({ status: "unavailable" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
    try { expect(await harness.experimental_call("diff", { ...input, comparison: listed.comparison })).toMatchObject({ status: "unavailable" }); }
    finally { clock.mockRestore(); }
    expect(shadowGit(ws, "for-each-ref", "refs/rewind-comparison")).toBe("");
    const refreshed = await harness.experimental_call("diff", input);
    if (refreshed.status !== "ok" || refreshed.comparison === undefined) throw new Error("No refreshed handle");
    await harness.experimental_dispose(); harness = makeHarness(dataDir, await tempDir("tmp"));
    expect(shadowGit(ws, "for-each-ref", "refs/rewind-comparison")).toBe("");
    expect(await harness.experimental_call("diff", { ...input, comparison: refreshed.comparison })).toMatchObject({ status: "unavailable" });
    const fresh = await harness.experimental_call("diff", input);
    if (fresh.status !== "ok" || fresh.comparison === undefined) throw new Error("No fresh handle");
    expect(await harness.experimental_call("releaseComparison", { workspace: ws, comparison: fresh.comparison })).toEqual({ released: true });
    expect(shadowGit(ws, "for-each-ref", "refs/rewind-comparison")).toBe("");
  });
  it("F14 bounds reads during ignore-source growth and closes handles after errors", async () => {
    const home = await tempDir("ignore-resource-home"), ws = await tempDir("ws");
    const source = path.join(home, ".config", "git", "ignore");
    await write(home, ".config/git/ignore", "#small\n"); await write(ws, "a.txt", "one\n");
    const priorHome = process.env.HOME, priorXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home; process.env.XDG_CONFIG_HOME = path.join(home, ".config"); resetGitBaseEnv(); clearUserRepoCaches();
    let bytes = 0, largestBuffer = 0, closed = 0, failRead = false, grow = true;
    const openFile = fsPromises.open;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args: Parameters<typeof openFile>) => {
      const handle = await openFile(...args);
      if (String(args[0]) === source) {
        const getStat = handle.stat.bind(handle);
        handle.stat = (async () => {
          const info = await getStat();
          if (grow) await writeFile(source, "#".repeat(2 * 1024 * 1024) + "\n*.secret\n");
          return info;
        }) as typeof handle.stat;
        const read = handle.read.bind(handle);
        handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
          largestBuffer = Math.max(largestBuffer, buffer.length);
          if (failRead) throw new Error("resource read failure");
          const result = await read(buffer, offset, length, position); bytes += result.bytesRead; return result;
        }) as typeof handle.read;
        const close = handle.close.bind(handle);
        handle.close = async () => { closed++; await close(); };
      }
      return handle;
    }); syncBuiltinESMExports();
    try {
      await expect(snap(ws)).rejects.toThrow(/ignore source.*exceeds/u);
      expect(bytes).toBeLessThanOrEqual(1024 * 1024 + 1); expect(largestBuffer).toBeLessThanOrEqual(1024 * 1024 + 1); expect(closed).toBe(1);
      await writeFile(source, "#small\n"); failRead = true;
      await expect(snap(ws)).rejects.toThrow(/resource read failure/u); expect(closed).toBe(2);
      grow = false; failRead = false; bytes = 0;
      await writeFile(source, "*.secret\n" + "#".repeat(1024 * 1024 - 9));
      await write(ws, "local.secret", "excluded\n");
      const captured = await okSnap(ws);
      expect(shadowGit(ws, "ls-tree", "-r", "--name-only", captured.commit)).not.toContain("local.secret");
      expect(bytes).toBe(1024 * 1024); expect(closed).toBe(3);
    } finally {
      spy.mockRestore(); syncBuiltinESMExports();
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
      resetGitBaseEnv(); clearUserRepoCaches();
    }
  });
  it("F06 stops capture at the first cancelled nested-boundary probe", async () => {
    const ws = await tempDir("ws");
    for (let i = 0; i < 300; i++) await write(ws, `dir${i}/file.txt`, "old\n");
    const old = await okSnap(ws);
    const controller = new AbortController(), realLstat = fsPromises.lstat;
    let probes = 0, afterCancellation = 0;
    const spy = vi.spyOn(fsPromises, "lstat").mockImplementation((async (...args: Parameters<typeof realLstat>) => {
      const nestedProbe = String(args[0]).startsWith(ws + path.sep) && String(args[0]).endsWith("/.git");
      if (nestedProbe) { probes++; if (controller.signal.aborted) afterCancellation++; }
      try { return await realLstat(...args); }
      finally { if (nestedProbe && probes === 1) controller.abort(); }
    }) as typeof realLstat); syncBuiltinESMExports();
    try {
      await expect(harness.experimental_call("diff", { workspace: ws, from: { kind: "checkpoint", commit: old.commit, checkpointId: old.checkpointId }, to: { kind: "workspace" }, paths: null, patch: false, maxFiles: 20, maxPatchBytesPerFile: 10000, maxPatchBytesTotal: 10000, limits: LIMITS }, { signal: controller.signal })).rejects.toThrow(/abort|cancel/u);
      expect(probes).toBeLessThanOrEqual(1);
      expect(afterCancellation).toBe(0);
      expect(activeLockCount()).toBe(0);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect((await okSnap(ws)).deduped).toBe(true);
  });
  it.each(["changed-files", "reduced-cap"])("F06 bounds cancelled capture stat workers (%s)", async phase => {
    const ws = await tempDir("ws");
    for (let i = 0; i < 300; i++) await write(ws, `f${i}.txt`, "old\n");
    const old = await okSnap(ws);
    if (phase === "changed-files") for (let i = 0; i < 300; i++) await write(ws, `f${i}.txt`, "changed\n");
    const controller = new AbortController(), realLstat = fsPromises.lstat, realAccess = fsPromises.access;
    let probes = 0, afterCancellation = 0, accesses = 0, settled = false;
    let batchReady!: () => void, releaseWorker!: () => void;
    const batch = new Promise<void>(resolve => { batchReady = resolve; });
    const workerBarrier = new Promise<void>(resolve => { releaseWorker = resolve; });
    const cancelled = new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    const spy = vi.spyOn(fsPromises, "lstat").mockImplementation((async (...args: Parameters<typeof realLstat>) => {
      const candidate = String(args[0]).startsWith(ws + path.sep) && /^f\d+\.txt$/u.test(path.basename(String(args[0])));
      const ordinal = candidate ? ++probes : 0;
      if (candidate && controller.signal.aborted) afterCancellation++;
      if (ordinal === 2) batchReady();
      const result = await realLstat(...args);
      if (ordinal === 1) { await batch; controller.abort(); }
      else if (ordinal > 1) { await cancelled; if (ordinal === 2) await workerBarrier; }
      return result;
    }) as typeof realLstat);
    const accessSpy = vi.spyOn(fsPromises, "access").mockImplementation(async (...args: Parameters<typeof realAccess>) => {
      if (String(args[0]).startsWith(ws + path.sep)) accesses++;
      return realAccess(...args);
    }); syncBuiltinESMExports();
    const diff = harness.experimental_call("diff", { workspace: ws, from: { kind: "checkpoint", commit: old.commit, checkpointId: old.checkpointId }, to: { kind: "workspace" }, paths: null, patch: false, maxFiles: 20, maxPatchBytesPerFile: 10000, maxPatchBytesTotal: 10000, limits: phase === "reduced-cap" ? { ...LIMITS, maxFileBytes: 3 } : LIMITS }, { signal: controller.signal });
    void diff.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(diff).rejects.toThrow(/abort|cancel/u);
    try {
      await cancelled;
      await new Promise<void>(resolve => setImmediate(resolve)); // Let cancellation continuations run, with one real I/O still admitted.
      expect(settled).toBe(false);
      expect(activeLockCount()).toBe(1);
      releaseWorker(); await rejected;
      // Only the bounded batch of already admitted filesystem calls may finish.
      expect(probes).toBeLessThanOrEqual(32);
      expect(afterCancellation).toBe(0);
      expect(accesses).toBe(0);
      expect(activeLockCount()).toBe(0);
    } finally { releaseWorker(); await rejected; spy.mockRestore(); accessSpy.mockRestore(); syncBuiltinESMExports(); }
    expect((await okSnap(ws)).status).toBe("ok");
  });
  it("F06 finishes and verifies a real restore after write-phase cancellation", async () => {
    const ws = await tempDir("ws"); await initRepo(ws, { "a.txt": "old\n", "nested/keep.txt": "keep\n" });
    const old = await okSnap(ws); await write(ws, "a.txt", "new\n"); await write(ws, "extra.txt", "delete\n");
    const controller = new AbortController(), spawn = childProcess.spawn;
    let writes = 0;
    const spy = vi.spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      if ((args[1] as string[]).includes("read-tree") && (args[1] as string[]).includes("-u")) {
        writes++; child.once("spawn", () => controller.abort());
      }
      return child;
    }) as typeof spawn); syncBuiltinESMExports();
    try {
      const preRestoreId = newId("ck");
      const result = await harness.experimental_call("restore", { workspace: ws, target: { commit: old.commit, checkpointId: old.checkpointId, sourceWorkspace: null }, preRestore: { checkpointId: preRestoreId, subject: "undo" }, dryRun: false, maxListed: 500, limits: LIMITS }, { signal: controller.signal });
      expect(controller.signal.aborted).toBe(true); expect(writes).toBe(1);
      expect(result).toMatchObject({ status: "ok", applied: true, verification: { ok: true }, applyError: null });
      expect(await readFile(path.join(ws, "a.txt"), "utf8")).toBe("old\n");
      expect(await exists(path.join(ws, "extra.txt"))).toBe(false);
      expect(await harness.experimental_call("refCommit", { workspace: ws, checkpointId: preRestoreId })).toMatchObject({ commit: expect.any(String) });
      expect(activeLockCount()).toBe(0);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it("F06 aborts an in-flight Git patch and the next snapshot obtains the lock", async () => {
    const ws = await tempDir("ws"); await initRepo(ws, { "a.txt": "old\n" }); const old = await okSnap(ws);
    await write(ws, "a.txt", "new\n");
    const controller = new AbortController(), spawn = childProcess.spawn; let patchProcesses = 0;
    const spy = vi.spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      if ((args[1] as string[]).includes("-p")) { patchProcesses++; child.once("spawn", () => controller.abort()); }
      return child;
    }) as typeof spawn); syncBuiltinESMExports();
    try {
      await expect(harness.experimental_call("diff", { workspace: ws, from: { kind: "checkpoint", commit: old.commit, checkpointId: old.checkpointId }, to: { kind: "workspace" }, paths: ["a.txt"], patch: true, maxFiles: 20, maxPatchBytesPerFile: 10000, maxPatchBytesTotal: 10000, limits: LIMITS }, { signal: controller.signal })).rejects.toThrow(/abort|cancel/u);
      expect(patchProcesses).toBe(1);
      expect((await okSnap(ws)).status).toBe("ok"); expect(activeLockCount()).toBe(0);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it("F09 verifies large disjoint skipped and leftover sets with bounded output", async () => {
    const ws = await tempDir("ws"); await write(ws, "a.txt", "old\n"); const old = await okSnap(ws);
    await write(ws, "a.txt", "new\n");
    for (let i = 0; i < 600; i++) await write(ws, `skipped/f${i}`, "x".repeat(64));
    const spawn = childProcess.spawn; let introduced = false;
    const spy = vi.spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
      const argv = args[1] as string[];
      if (!introduced && argv.includes("read-tree") && argv.includes("-u")) {
        introduced = true; mkdirSync(path.join(ws, "leftovers"));
        for (let i = 0; i < 600; i++) writeFileSync(path.join(ws, "leftovers", `f${i}`), "late\n");
      }
      return spawn(...args);
    }) as typeof spawn); syncBuiltinESMExports();
    try {
      const result = await restore(ws, old, { limits: { ...LIMITS, maxFileBytes: 32 } });
      expect(result.verification?.ok).toBe(true);
      expect(result.verification?.untouchedCount).toBe(600);
      expect(result.verification?.untouched).toHaveLength(50);
      expect(result.verification?.untouched.every(p => p.startsWith("leftovers/"))).toBe(true);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it("F08 reuses immutable comparison trees for patches without recapturing", async () => {
    const ws = await tempDir("ws"); await initRepo(ws, { "a.txt": "old\n", "b.txt": "old\n", "c.txt": "old\n" });
    const first = await okSnap(ws);
    for (const name of ["a", "b", "c"]) await write(ws, `${name}.txt`, "listed current\n");
    const spawn = childProcess.spawn; let captures = 0;
    const spy = vi.spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
      if ((args[1] as string[]).includes("status")) captures++;
      return spawn(...args);
    }) as typeof spawn); syncBuiltinESMExports();
    const input = { workspace: ws, from: { kind: "checkpoint" as const, commit: first.commit, checkpointId: first.checkpointId }, to: { kind: "workspace" as const }, paths: null, patch: false, maxFiles: 20, maxPatchBytesPerFile: 10000, maxPatchBytesTotal: 10000, limits: LIMITS };
    try {
      const listed = await harness.experimental_call("diff", input);
      if (listed.status !== "ok") throw new Error(listed.status);
      const comparison = (listed as typeof listed & { comparison?: string }).comparison;
      await write(ws, "a.txt", "edited after list\n");
      for (const name of ["a", "b", "c"]) {
        const patch = await harness.experimental_call("diff", { ...input, paths: [`${name}.txt`], patch: true, ...(comparison === undefined ? {} : { comparison }) });
        if (patch.status !== "ok") throw new Error(patch.status);
        expect(patch.toTree).toBe(listed.toTree);
        expect(patch.files[0]?.patch).toContain("listed current");
      }
      expect(captures).toBeLessThanOrEqual(1);
      expect(comparison).toBeTruthy();
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it.each(["normal", "budget", "cancel"])("F07 isolates one real submodule path among 1001 changes within a bounded Git budget (%s)", async scenario => {
    const ws = await tempDir("ws"); await initRepo(ws, { "sub/file.txt": "old\n" });
    for (let i = 0; i < 1000; i++) await write(ws, `files/f${i}.txt`, "old\n");
    const old = await okSnap(ws);
    for (let i = 0; i < 1000; i++) await write(ws, `files/f${i}.txt`, "new\n");
    await initRepo(path.join(ws, "sub"), { "file.txt": "nested\n" });
    userGit(ws, "rm", "--cached", "sub/file.txt");
    userGit(ws, "update-index", "--add", "--cacheinfo", `160000,${userGit(path.join(ws, "sub"), "rev-parse", "HEAD").trim()},sub`);
    const spawn = childProcess.spawn; let checks = 0, now = Date.now();
    const clock = scenario === "budget" ? vi.spyOn(Date, "now").mockImplementation(() => now) : null;
    const controller = new AbortController();
    const spy = vi.spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
      if ((args[1] as string[]).includes("check-ignore")) {
        checks++;
        if (scenario === "budget") now += 31_000;
        if (scenario === "cancel") controller.abort();
      }
      return spawn(...args);
    }) as typeof spawn); syncBuiltinESMExports();
    try {
      if (scenario === "cancel") {
        await expect(harness.experimental_call("restore", { workspace: ws, target: { commit: old.commit, checkpointId: old.checkpointId, sourceWorkspace: null }, preRestore: null, dryRun: true, maxListed: 500, limits: LIMITS }, { signal: controller.signal })).rejects.toThrow(/abort|cancel/u);
        expect(checks).toBeLessThanOrEqual(1);
        await okSnap(ws); // No cancelled process or lock may retain the queue.
      } else {
        const result = await restore(ws, old, { dryRun: true });
        if (scenario === "normal") expect(result.plan.protected.map(p => p.path)).toContain("sub/file.txt");
        else {
          expect(result.plan.protectedCount).toBe(1001);
          expect(result.plan.writes).toBe(0); expect(result.plan.creates).toBe(0);
          expect(checks).toBeLessThanOrEqual(2);
        }
        expect(checks).toBeLessThanOrEqual(32); // Logarithmic isolation, not 1001 serial Git calls.
      }
      expect(await readFile(path.join(ws, "files/f0.txt"), "utf8")).toBe("new\n");
    } finally { clock?.mockRestore(); spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it("F06 cancelled queued diffs never begin capture and release the queue", async () => {
    const ws = await tempDir("ws"); await write(ws, "a.txt", "one\n"); const first = await okSnap(ws);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; }), barrier = new Promise<void>(r => { release = r; });
    const read = fsPromises.readFile;
    let held = false;
    const spy = vi.spyOn(fsPromises, "readFile").mockImplementation((async (...args: Parameters<typeof read>) => {
      if (!held && String(args[0]).endsWith("state.json")) { held = true; entered(); await barrier; }
      return read(...args);
    }) as typeof read);
    syncBuiltinESMExports();
    const saving = snap(ws);
    await started;
    const controller = new AbortController();
    const cancelled = harness.experimental_call("diff", {
      workspace: ws, from: { kind: "checkpoint", commit: first.commit, checkpointId: first.checkpointId }, to: { kind: "workspace" }, paths: null, patch: true,
      maxFiles: 20, maxPatchBytesPerFile: 10000, maxPatchBytesTotal: 10000, limits: LIMITS,
    }, { signal: controller.signal });
    const observed = expect(cancelled).rejects.toThrow(/abort|cancel/u);
    controller.abort(); release();
    try { await saving; await observed; expect((await okSnap(ws)).deduped).toBe(true); }
    finally { release(); spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it.each(["global", "info", "ancestor"])("F14 refuses oversized ignore sources with rules beyond the cap before restore writes (%s)", async sourceKind => {
    const home = await tempDir("ignore-home"), root = await tempDir("ws");
    if (sourceKind !== "global") await initRepo(root, { "root.txt": "one\n" });
    const ws = sourceKind === "ancestor" ? path.join(root, "sub") : root;
    await write(ws, "a.txt", "one\n");
    const old = await okSnap(ws); await write(ws, "a.txt", "keep\n");
    const source = sourceKind === "global" ? path.join(home, ".config/git/ignore") : sourceKind === "info" ? path.join(root, ".git/info/exclude") : path.join(root, ".gitignore");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "#".repeat(1024 * 1024 + 10) + "\n*.secret\n");
    await write(ws, "late.secret", "must not capture\n");
    const priorHome = process.env.HOME, priorXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home; process.env.XDG_CONFIG_HOME = path.join(home, ".config"); resetGitBaseEnv(); clearUserRepoCaches();
    try {
      await expect(snap(ws)).rejects.toThrow(/ignore source.*exceeds/u);
      await expect(restore(ws, old)).rejects.toThrow(/ignore source.*exceeds/u);
      expect(await readFile(path.join(ws, "a.txt"), "utf8")).toBe("keep\n");
    } finally {
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
      resetGitBaseEnv(); clearUserRepoCaches();
    }
  });
  it("U03 stops capturing an untracked forced ignored file without ignore edits after TTL", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { ".gitignore": "build/\n", "plain.txt": "ok\n" });
    await write(ws, "build/forced.txt", "old forced\n"); userGit(ws, "add", "-f", "build/forced.txt");
    const old = await okSnap(ws);
    userGit(ws, "rm", "--cached", "build/forced.txt");
    await write(ws, "build/forced.txt", "now private\n");
    const warm = await okSnap(ws);
    expect(shadowGit(ws, "ls-tree", "-r", "--name-only", warm.commit)).not.toContain("build/forced.txt");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    try {
      const current = await okSnap(ws);
      expect(shadowGit(ws, "ls-tree", "-r", "--name-only", current.commit)).not.toContain("build/forced.txt");
      await restore(ws, old);
      expect(await readFile(path.join(ws, "build/forced.txt"), "utf8")).toBe("now private\n");
      expect(await readFile(path.join(ws, ".gitignore"), "utf8")).toBe("build/\n");
    } finally { clock.mockRestore(); }
  });
  it.each([false, true])("U03 reconciles removed forced membership across a cold worker without changing ignores (expired=%s)", async expired => {
    const ws = await tempDir("ws");
    await initRepo(ws, { ".gitignore": "build/\n", "plain.txt": "ok\n" });
    await write(ws, "build/forced.txt", "old forced\n"); userGit(ws, "add", "-f", "build/forced.txt");
    const old = await okSnap(ws);
    await harness.experimental_dispose();
    // Remove membership while the worker is down. Do not clear caches or edit
    // ignore rules: exercise the external index stamp and persisted hash.
    userGit(ws, "rm", "--cached", "build/forced.txt"); await write(ws, "build/forced.txt", "cold private bytes\n");
    const userBefore = await fingerprint(path.join(ws, ".git"));
    const clock = expired ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001) : null;
    try {
      harness = makeHarness(dataDir, await tempDir("cold-tmp"));
      const current = await okSnap(ws);
      expect(shadowGit(ws, "ls-tree", "-r", "--name-only", current.commit)).not.toContain("build/forced.txt");
      await restore(ws, old);
      expect(await readFile(path.join(ws, "build/forced.txt"), "utf8")).toBe("cold private bytes\n");
      expect(await readFile(path.join(ws, ".gitignore"), "utf8")).toBe("build/\n");
      expect(await fingerprint(path.join(ws, ".git"))).toEqual(userBefore);
    } finally { clock?.mockRestore(); }
  });
  it.each(["local", "global", "ancestor"])("F05 protects existing and absent targets using current ignores (%s)", async sourceKind => {
    const root = await tempDir("ignore-root"), home = await tempDir("ignore-home");
    const previousHome = process.env.HOME, previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home; process.env.XDG_CONFIG_HOME = path.join(home, ".config"); resetGitBaseEnv(); clearUserRepoCaches();
    try {
      if (sourceKind === "ancestor") await initRepo(root, { "root.txt": "one\n" });
      const ws = sourceKind === "ancestor" ? path.join(root, "sub") : root;
      await write(ws, ".env", "obsolete secret\n"); await write(ws, "existing.log", "old\n");
      const old = await okSnap(ws);
      const source = sourceKind === "global" ? path.join(home, ".config/git/ignore") : path.join(root, ".gitignore");
      await mkdir(path.dirname(source), { recursive: true }); await writeFile(source, ".env\n*.log\n");
      await unlink(path.join(ws, ".env")); await write(ws, "existing.log", "keep current\n");
      const preview = await restore(ws, old, { dryRun: true });
      expect(preview.plan.protected.map(p => p.path)).toEqual(expect.arrayContaining([".env", "existing.log"]));
      await restore(ws, old);
      expect(await exists(path.join(ws, ".env"))).toBe(false);
      expect(await readFile(path.join(ws, "existing.log"), "utf8")).toBe("keep current\n");
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
      resetGitBaseEnv(); clearUserRepoCaches();
    }
  });
  it.each(["stored-policy", "legacy-policy"])("F11 revalidates unchanged indexed files after lowering the cap and protects oversized old targets (%s)", async policy => {
    const ws = await tempDir("ws");
    await write(ws, "large.txt", "1234567890"); await write(ws, "small.txt", "one");
    const old = await okSnap(ws);
    if (policy === "legacy-policy") {
      // Persisted legacy input, not a private-method substitute: the pre-fix
      // state format had no maxFileBytes. Recreate the public worker around it.
      await harness.experimental_dispose();
      const stateFile = path.join(dataDir, "shadows", shadowKey(ws), "state.json");
      const legacy = JSON.parse(await readFile(stateFile, "utf8")); delete legacy.maxFileBytes;
      await writeFile(stateFile, JSON.stringify(legacy));
      harness = makeHarness(dataDir, await tempDir("legacy-tmp"));
    }
    const limits = { ...LIMITS, maxFileBytes: 5 };
    const smaller = await okSnap(ws, { limits });
    expect(smaller.skipped).toContainEqual({ path: "large.txt", reason: "too-large", sizeBytes: 10 });
    expect(shadowGit(ws, "ls-tree", "-r", "--name-only", smaller.commit)).not.toContain("large.txt");
    await write(ws, "large.txt", "keep new larger bytes");
    await restore(ws, old, { limits });
    expect(await readFile(path.join(ws, "large.txt"), "utf8")).toBe("keep new larger bytes");
    await unlink(path.join(ws, "large.txt"));
    await restore(ws, old, { limits });
    expect(await exists(path.join(ws, "large.txt"))).toBe(false);
  });
  it.each(["directory", "gitfile"])("F04 drops unchanged indexed descendants of a new nested repository (%s) and protects old targets", async kind => {
    const ws = await tempDir("nongit");
    await write(ws, "lib/unchanged.txt", "old unchanged\n"); await write(ws, "lib/changed.txt", "old changed\n");
    const old = await okSnap(ws);
    const gitDir = kind === "gitfile" ? await tempDir("nested-git") : path.join(ws, "lib", ".git");
    if (kind === "gitfile") userGit(path.join(ws, "lib"), "init", "-q", `--separate-git-dir=${gitDir}`);
    else userGit(path.join(ws, "lib"), "init", "-q");
    await write(ws, "lib/changed.txt", "nested new\n");
    const gitBefore = await fingerprint(gitDir);
    const gitfileBefore = kind === "gitfile" ? await readFile(path.join(ws, "lib", ".git"), "utf8") : null;
    const current = await okSnap(ws);
    expect(shadowGit(ws, "ls-tree", "-r", "--name-only", current.commit)).not.toContain("lib/");
    await unlink(path.join(ws, "lib", "unchanged.txt"));
    const result = await restore(ws, old);
    expect(result.plan.protectedCount).toBe(2);
    expect(await exists(path.join(ws, "lib", "unchanged.txt"))).toBe(false);
    expect(await readFile(path.join(ws, "lib", "changed.txt"), "utf8")).toBe("nested new\n");
    expect(await fingerprint(gitDir)).toEqual(gitBefore);
    if (gitfileBefore !== null) expect(await readFile(path.join(ws, "lib", ".git"), "utf8")).toBe(gitfileBefore);
  });
  it("U01 captures external edits with inherited ignoreStat and repairs legacy flags", async () => {
    const home = await tempDir("isolated-home");
    await write(home, ".gitconfig", "[core]\n\tignoreStat = true\n");
    const priorHome = process.env.HOME, priorXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home; process.env.XDG_CONFIG_HOME = path.join(home, ".config"); resetGitBaseEnv();
    try {
      const ws = await tempDir("ws");
      await initRepo(ws, { "a.txt": "one\n" });
      const userIndexBefore = await fingerprint(path.join(ws, ".git"));
      const first = await okSnap(ws);
      await write(ws, "a.txt", "external two\n");
      const second = await okSnap(ws);
      expect(second.tree).not.toBe(first.tree);
      // A released store can already carry assume-unchanged flags. Remove migration bookkeeping to model it.
      const stateFile = path.join(dataDir, "shadows", shadowKey(ws), "state.json");
      const state = JSON.parse(await readFile(stateFile, "utf8")); delete state.assumeUnchangedCleared;
      await writeFile(stateFile, JSON.stringify(state));
      shadowGit(ws, `--work-tree=${ws}`, "update-index", "--assume-unchanged", "--", "a.txt");
      await harness.experimental_dispose(); harness = makeHarness(dataDir, await tempDir("tmp"));
      await write(ws, "a.txt", "legacy external three\n");
      const third = await okSnap(ws);
      expect(third.tree).not.toBe(second.tree);
      expect(shadowGit(ws, "ls-files", "-v")).not.toMatch(/^h /mu);
      await restore(ws, first);
      expect(await readFile(path.join(ws, "a.txt"), "utf8")).toBe("one\n");
      expect(await fingerprint(path.join(ws, ".git"))).toBe(userIndexBefore);
    } finally {
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
      resetGitBaseEnv();
    }
  });
});

describe("snapshot and restore", () => {
  it.skipIf(!POSIX)("restores created, modified, deleted, renamed, chmodded, symlinked and binary files byte for byte", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, {
      "a.txt": "alpha\n",
      "b.txt": "bravo\n",
      "dir/c.txt": "charlie\n",
      "script.sh": "#!/bin/sh\necho hi\n",
      "to-symlink.txt": "becomes a symlink\n",
    });
    await write(ws, "keep.bin", Buffer.from([0, 1, 2, 3, 255, 254, 0, 7]));
    await link(ws, "link-old", "a.txt");
    const userGitBefore = await fingerprint(path.join(ws, ".git"));
    const before = await snapshotTree(ws);
    const first = await okSnap(ws);
    expect(first.head?.branch).toBe("main");

    // The agent's turn.
    await write(ws, "a.txt", "alpha changed\nmore\n");
    await unlink(path.join(ws, "b.txt"));
    await rename(path.join(ws, "dir/c.txt"), path.join(ws, "dir/renamed.txt"));
    await chmod(path.join(ws, "script.sh"), 0o755);
    await link(ws, "link-new", "dir/renamed.txt");
    await unlink(path.join(ws, "link-old"));
    await symlink("b.txt", path.join(ws, "link-old"));
    await write(ws, "new.bin", Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 7) % 256)));
    await write(ws, "keep.bin", Buffer.from([9, 9, 9, 0, 0, 1]));
    await write(ws, "deep/x/y.txt", "deep\n");
    await unlink(path.join(ws, "to-symlink.txt"));
    await symlink("a.txt", path.join(ws, "to-symlink.txt"));
    const after = await snapshotTree(ws);
    const second = await okSnap(ws, { compareTo: first.commit });
    expect(second.stats.files).toBeGreaterThanOrEqual(10);
    const statuses = Object.fromEntries(second.changes.map((change) => [change.path, change.status]));
    expect(statuses).toMatchObject({
      "a.txt": "M",
      "b.txt": "D",
      "dir/c.txt": "D",
      "dir/renamed.txt": "A",
      "script.sh": "M",
      "link-new": "A",
      "new.bin": "A",
      "to-symlink.txt": "T",
    });
    expect(second.changes.find((change) => change.path === "new.bin")?.binary).toBe(true);

    const restored = await restore(ws, first);
    expect(restored.applied).toBe(true);
    expect(restored.verification?.ok).toBe(true);
    expect(restored.verification?.mismatches).toEqual([]);
    expect(restored.preRestore?.tree).toBe(second.tree);
    expect(treeToObject(await snapshotTree(ws))).toEqual(treeToObject(before));

    // Undo: restore the pre-restore checkpoint.
    const undo = await restore(ws, { checkpointId: restored.preRestoreId, commit: restored.preRestore!.commit });
    expect(undo.verification?.ok).toBe(true);
    expect(treeToObject(await snapshotTree(ws))).toEqual(treeToObject(after));

    // And undo the undo.
    const redo = await restore(ws, { checkpointId: undo.preRestoreId, commit: undo.preRestore!.commit });
    expect(redo.verification?.ok).toBe(true);
    expect(treeToObject(await snapshotTree(ws))).toEqual(treeToObject(before));

    // Rewind never wrote into the user's repository.
    expect(await fingerprint(path.join(ws, ".git"))).toBe(userGitBefore);
  });

  it("a dry run reports the plan and changes nothing", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "one\n" });
    const first = await okSnap(ws);
    await write(ws, "a.txt", "two\n");
    await write(ws, "extra.txt", "extra\n");
    const tree = await snapshotTree(ws);
    const refsBefore = shadowGit(ws, "for-each-ref", "--format=%(refname)");
    const plan = await restore(ws, first, { dryRun: true });
    expect(plan.applied).toBe(false);
    expect(plan.preRestore).toBeNull();
    expect(plan.plan).toMatchObject({ writes: 1, deletes: 1, creates: 0, protectedCount: 0 });
    expect(plan.plan.changes.map((change) => [change.path, change.action]).sort()).toEqual([
      ["a.txt", "write"],
      ["extra.txt", "delete"],
    ]);
    expect(treeToObject(await snapshotTree(ws))).toEqual(treeToObject(tree));
    expect(shadowGit(ws, "for-each-ref", "--format=%(refname)")).toBe(refsBefore);
  });

  it("deduplicates unchanged trees", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "one\n", "b.txt": "two\n" });
    const first = await okSnap(ws);
    const objectsBefore = shadowGit(ws, "count-objects", "-v");
    const second = await okSnap(ws, { compareTo: first.commit });
    expect(second.deduped).toBe(true);
    expect(second.commit).toBe(first.commit);
    expect(second.tree).toBe(first.tree);
    expect(second.stats).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(shadowGit(ws, "count-objects", "-v")).toBe(objectsBefore);
    // Both checkpoints are still addressable by their own refs.
    expect(shadowGit(ws, "rev-parse", `refs/rewind/${first.checkpointId}`, `refs/rewind/${second.checkpointId}`).trim().split("\n")).toEqual([
      first.commit,
      first.commit,
    ]);
    await write(ws, "b.txt", "changed\n");
    const third = await okSnap(ws, { compareTo: second.commit });
    expect(third.deduped).toBe(false);
    expect(third.stats).toEqual({ files: 1, insertions: 1, deletions: 1 });
  });

  it("keeps older comparison baselines even when the current tree is deduplicated", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "one\n" });
    const first = await okSnap(ws);
    await write(ws, "a.txt", "two\n");
    const second = await okSnap(ws, { compareTo: first.commit });
    await write(ws, "b.txt", "new\n");
    const latest = await okSnap(ws, { compareTo: second.commit });

    const older = await okSnap(ws, { compareTo: first.commit });
    expect(older.deduped).toBe(true);
    expect(older.commit).toBe(latest.commit);
    expect(older.comparedTo).toBe(first.tree);
    expect(older.changes.map((change) => [change.path, change.status])).toEqual([["a.txt", "M"], ["b.txt", "A"]]);

    const recent = await okSnap(ws, { compareTo: latest.commit });
    expect(recent.comparedTo).toBe(latest.tree);
    expect(recent.stats.files).toBe(0);
    const missing = await okSnap(ws, { compareTo: "f".repeat(40) });
    expect(missing.comparedTo).toBe(latest.tree);
    expect(missing.stats.files).toBe(0);
  });

  it("serializes concurrent snapshots of one workspace", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "one\n" });
    const results = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        await write(ws, `file-${index}.txt`, `${index}\n`);
        return snap(ws);
      }),
    );
    for (const { result } of results) expect(result.status).toBe("ok");
    const refs = shadowGit(ws, "for-each-ref", "--format=%(refname)").trim().split("\n");
    expect(refs.filter((ref) => ref.startsWith("refs/rewind/"))).toHaveLength(6);
    expect(activeLockCount()).toBe(0);
    // The last snapshot holds every file.
    const lastTree = shadowGit(ws, "ls-tree", "-r", "--name-only", `refs/rewind/${results.at(-1)!.checkpointId}`);
    for (let index = 0; index < 6; index += 1) expect(lastTree).toContain(`file-${index}.txt`);
  });

  it("works in a workspace that is not a git repository", async () => {
    const ws = await tempDir("plain");
    await write(ws, ".gitignore", "cache/\n");
    await write(ws, "notes.md", "# notes\n");
    await write(ws, "cache/blob", "ignored\n");
    const first = await okSnap(ws);
    expect(first.head).toBeNull();
    const before = await snapshotTree(ws, { skip: (relative) => relative.startsWith("cache") });
    await write(ws, "notes.md", "# notes\nedited\n");
    await write(ws, "new.md", "new\n");
    await write(ws, "cache/blob", "still ignored, changed\n");
    const restored = await restore(ws, first);
    expect(restored.verification?.ok).toBe(true);
    expect(restored.head).toBeNull();
    expect(treeToObject(await snapshotTree(ws, { skip: (relative) => relative.startsWith("cache") }))).toEqual(treeToObject(before));
    expect(await readFile(path.join(ws, "cache/blob"), "utf8")).toBe("still ignored, changed\n");
    expect(await exists(path.join(ws, ".git"))).toBe(false);
  });

  it("reports a missing workspace instead of failing", async () => {
    const { result } = await snap("/definitely/not/a/workspace/rewind-test");
    expect(result).toEqual({ status: "missing", reason: "The workspace directory does not exist." });
  });
});

describe("what a restore never touches", () => {
  it("leaves ignored files alone, even where the checkpoint has a file at that path", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "src/app.js": "v1\n", "keep.log": "tracked log v1\n" });
    const first = await okSnap(ws);
    // The repository starts ignoring things; ignored files come and go.
    userGit(ws, "rm", "-q", "--cached", "keep.log");
    await write(ws, ".gitignore", "node_modules/\n.env\n*.log\n");
    await write(ws, ".env", "SECRET=1\n");
    await write(ws, "node_modules/pkg/index.js", "module\n");
    await write(ws, "keep.log", "now ignored and edited\n");
    await write(ws, "src/app.js", "v2\n");
    await okSnap(ws);

    const restored = await restore(ws, first);
    expect(restored.verification?.ok).toBe(true);
    expect(await readFile(path.join(ws, "src/app.js"), "utf8")).toBe("v1\n");
    expect(await readFile(path.join(ws, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(await readFile(path.join(ws, "node_modules/pkg/index.js"), "utf8")).toBe("module\n");
    // The checkpoint had keep.log; it is ignored now, so it keeps its content.
    expect(await readFile(path.join(ws, "keep.log"), "utf8")).toBe("now ignored and edited\n");
    expect(restored.plan.protected).toContainEqual(expect.objectContaining({ path: "keep.log", action: "create" }));
    // .gitignore itself was not in the checkpoint: a restore deletes it.
    expect(await exists(path.join(ws, ".gitignore"))).toBe(false);
  });

  it("keeps a directory holding ignored files when the checkpoint has a file there", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "x": "x was a file\n", ".gitignore": "secret\n" });
    const first = await okSnap(ws);
    await rm(path.join(ws, "x"));
    await write(ws, "x/tracked.txt", "now a directory\n");
    await write(ws, "x/secret", "ignored, must survive\n");
    await okSnap(ws);
    const restored = await restore(ws, first);
    expect(await readFile(path.join(ws, "x/secret"), "utf8")).toBe("ignored, must survive\n");
    expect(await readFile(path.join(ws, "x/tracked.txt"), "utf8")).toBe("now a directory\n");
    expect(restored.plan.protected.map((entry) => [entry.path, entry.reason])).toEqual(
      expect.arrayContaining([
        ["x", "directory-has-uncaptured"],
        ["x/tracked.txt", "directory-has-uncaptured"],
      ]),
    );
    expect(restored.verification?.ok).toBe(true);
  });

  it("skips files over the size cap and never deletes or overwrites them", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "small.dat": "x".repeat(100), "code.ts": "export {}\n" });
    const limits = { ...LIMITS, maxFileBytes: 1000 };
    const first = await okSnap(ws, { limits });
    await write(ws, "big.bin", Buffer.alloc(5000, 7));
    await write(ws, "small.dat", "y".repeat(5000)); // a captured file grows past the cap
    await write(ws, "code.ts", "export const x = 1;\n");
    const second = await okSnap(ws, { limits });
    expect(second.skipped).toEqual(
      expect.arrayContaining([
        { path: "big.bin", reason: "too-large", sizeBytes: 5000 },
        { path: "small.dat", reason: "too-large", sizeBytes: 5000 },
      ]),
    );
    expect(shadowGit(ws, "ls-tree", "-r", "--name-only", second.commit)).not.toContain("big.bin");

    const restored = await restore(ws, first, { limits });
    expect(await readFile(path.join(ws, "code.ts"), "utf8")).toBe("export {}\n");
    expect((await readFile(path.join(ws, "big.bin"))).length).toBe(5000);
    expect(await readFile(path.join(ws, "small.dat"), "utf8")).toBe("y".repeat(5000));
    expect(restored.plan.protected).toContainEqual({ path: "small.dat", reason: "exists-uncaptured", action: "create" });
    expect(restored.verification?.ok).toBe(true);
  });

  it("skips nested repositories, including ones without commits, and leaves them alone", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "a\n" });
    const nested = path.join(ws, "vendor/lib");
    await write(nested, "lib.txt", "lib\n");
    userGit(nested, "init", "-q");
    userGit(nested, "add", "-A");
    userGit(nested, "commit", "-q", "-m", "lib");
    const empty = path.join(ws, "scratch-repo");
    await write(empty, "draft.txt", "draft\n");
    userGit(empty, "init", "-q");
    const first = await okSnap(ws);
    expect(first.skipped.map((entry) => [entry.path, entry.reason]).sort()).toEqual([
      ["scratch-repo", "nested-repository"],
      ["vendor/lib", "nested-repository"],
    ]);
    await write(ws, "a.txt", "changed\n");
    await write(nested, "lib.txt", "lib changed\n");
    await write(empty, "draft.txt", "draft changed\n");
    const restored = await restore(ws, first);
    expect(await readFile(path.join(ws, "a.txt"), "utf8")).toBe("a\n");
    expect(await readFile(path.join(nested, "lib.txt"), "utf8")).toBe("lib changed\n");
    expect(await readFile(path.join(empty, "draft.txt"), "utf8")).toBe("draft changed\n");
    expect(restored.verification?.ok).toBe(true);
  });

  it("captures files the repository tracks even though its ignore rules match them", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { ".gitignore": "dist/\n", "src.ts": "src\n" });
    await write(ws, "dist/bundle.js", "bundle v1\n");
    userGit(ws, "add", "-f", "dist/bundle.js");
    userGit(ws, "commit", "-q", "-m", "force-add bundle");
    await write(ws, "dist/other.js", "untracked build output\n");
    const first = await okSnap(ws);
    const files = shadowGit(ws, "ls-tree", "-r", "--name-only", first.commit);
    expect(files).toContain("dist/bundle.js");
    expect(files).not.toContain("dist/other.js");
    await write(ws, "dist/bundle.js", "bundle v2\n");
    const restored = await restore(ws, first);
    expect(await readFile(path.join(ws, "dist/bundle.js"), "utf8")).toBe("bundle v1\n");
    expect(await readFile(path.join(ws, "dist/other.js"), "utf8")).toBe("untracked build output\n");
    expect(restored.verification?.ok).toBe(true);
  });

  it("captures and restores more than 500 tracked-but-ignored files without counting them twice", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { ".gitignore": "build/\n", "src.ts": "src\n" });
    for (let index = 0; index < 600; index += 1) {
      await write(ws, `build/file-${String(index).padStart(3, "0")}.txt`, `${index}\n`);
    }
    const unusual = "build/space [literal] é.txt";
    await write(ws, unusual, "unicode\n");
    userGit(ws, "add", "-f", "--", "build/");
    await write(ws, "build/untracked.txt", "ignored output\n");
    const userGitBefore = await fingerprint(path.join(ws, ".git"));
    const limits = { ...LIMITS, maxFiles: 603, maxFileBytes: 64 };

    const first = await okSnap(ws, { limits });
    expect(first.fileCount).toBe(603);
    const unchanged = await okSnap(ws, { limits, compareTo: first.commit });
    expect(unchanged.fileCount).toBe(603);
    expect(unchanged.deduped).toBe(true);
    expect(unchanged.stats.files).toBe(0);

    await write(ws, "build/file-000.txt", "edited\n");
    await unlink(path.join(ws, "build/file-599.txt"));
    await write(ws, "build/file-003.txt", Buffer.alloc(65, 7));
    if (POSIX) {
      await chmod(path.join(ws, "build/file-001.txt"), 0o755);
      await unlink(path.join(ws, "build/file-002.txt"));
      await link(ws, "build/file-002.txt", "../src.ts");
    }
    const changed = await okSnap(ws, { limits, compareTo: unchanged.commit });
    expect(changed.fileCount).toBe(601);
    expect(Object.fromEntries(changed.changes.map((change) => [change.path, change.status]))).toMatchObject({
      "build/file-000.txt": "M",
      "build/file-599.txt": "D",
      "build/file-003.txt": "D",
      ...(POSIX ? { "build/file-001.txt": "M", "build/file-002.txt": "T" } : {}),
    });
    expect(changed.skipped).toContainEqual({ path: "build/file-003.txt", reason: "too-large", sizeBytes: 65 });

    const restored = await restore(ws, first, { limits });
    expect(restored.verification?.ok).toBe(true);
    expect(await readFile(path.join(ws, "build/file-000.txt"), "utf8")).toBe("0\n");
    expect(await readFile(path.join(ws, "build/file-599.txt"), "utf8")).toBe("599\n");
    expect(await readFile(path.join(ws, unusual), "utf8")).toBe("unicode\n");
    expect(await readFile(path.join(ws, "build/file-003.txt"))).toEqual(Buffer.alloc(65, 7));
    expect(await readFile(path.join(ws, "build/untracked.txt"), "utf8")).toBe("ignored output\n");
    if (POSIX) {
      expect((await lstat(path.join(ws, "build/file-002.txt"))).isFile()).toBe(true);
      expect((await lstat(path.join(ws, "build/file-001.txt"))).mode & 0o111).toBe(0);
    }
    expect(await fingerprint(path.join(ws, ".git"))).toBe(userGitBefore);
  });

  it("refreshes forced-file membership when the user index and ignore rules change", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { ".gitignore": "build/\n", "src.ts": "src\n" });
    await write(ws, "build/old.txt", "old v1\n");
    userGit(ws, "add", "-f", "--", "build/old.txt");
    const first = await okSnap(ws);

    await write(ws, "build/new.txt", "new\n");
    userGit(ws, "add", "-f", "--", "build/new.txt");
    // Simulate the existing forced-list cache expiring after the index change.
    clearUserRepoCaches();
    const second = await okSnap(ws, { compareTo: first.commit });
    expect(second.fileCount).toBe(4);
    expect(second.changes.map((change) => [change.path, change.status])).toEqual([["build/new.txt", "A"]]);

    userGit(ws, "rm", "--cached", "--", "build/old.txt");
    await write(ws, ".gitignore", "build/\n# refreshed rules\n");
    await write(ws, "build/old.txt", "now uncaptured\n");
    clearUserRepoCaches();
    const userGitBefore = await fingerprint(path.join(ws, ".git"));
    const third = await okSnap(ws, { compareTo: second.commit });
    expect(third.fileCount).toBe(3);
    expect(third.changes.map((change) => [change.path, change.status])).toEqual([[".gitignore", "M"], ["build/old.txt", "D"]]);

    const restored = await restore(ws, first);
    expect(restored.verification?.ok).toBe(true);
    expect(await readFile(path.join(ws, "build/old.txt"), "utf8")).toBe("now uncaptured\n");
    expect(await fingerprint(path.join(ws, ".git"))).toBe(userGitBefore);
  });

  it.skipIf(!POSIX)("captures non-UTF-8 tracked-but-ignored names at the exact file limit", async (context) => {
    const ws = await tempDir("ws");
    await initRepo(ws, { ".gitignore": "build/\n", "src.ts": "src\n" });
    await mkdir(path.join(ws, "build"));
    const rawPath = Buffer.concat([Buffer.from(`${ws}/build/invalid-`), Buffer.from([0xff]), Buffer.from(".bin")]);
    try {
      await writeFile(rawPath, "raw v1\n");
    } catch (error) {
      // APFS rejects non-UTF-8 names even when passed as raw bytes.
      if ((error as NodeJS.ErrnoException).code !== "EILSEQ") throw error;
      context.skip();
      return;
    }
    userGit(ws, "add", "-f", "--", "build/");
    await write(ws, "build/untracked.bin", "ignored output\n");
    const userGitBefore = await fingerprint(path.join(ws, ".git"));
    const limits = { ...LIMITS, maxFiles: 3 };

    const first = await okSnap(ws, { limits });
    expect(first.fileCount).toBe(3);
    const unchanged = await okSnap(ws, { limits, compareTo: first.commit });
    expect(unchanged.deduped).toBe(true);
    expect(unchanged.stats.files).toBe(0);
    expect(unchanged.fileCount).toBe(3);

    await writeFile(rawPath, "raw v2\n");
    const changed = await okSnap(ws, { limits, compareTo: unchanged.commit });
    expect(changed.stats.files).toBe(1);
    const restored = await restore(ws, first, { limits });
    expect(restored.verification?.ok).toBe(true);
    expect(await readFile(rawPath, "utf8")).toBe("raw v1\n");
    expect(await readFile(path.join(ws, "build/untracked.bin"), "utf8")).toBe("ignored output\n");
    expect(await fingerprint(path.join(ws, ".git"))).toBe(userGitBefore);
  });

  it("honors ignore rules above a workspace that is a repository subdirectory", async () => {
    const repo = await tempDir("mono");
    await initRepo(repo, {
      ".gitignore": "node_modules\n/packages/app/build/\n*.tmp\n",
      "packages/app/index.ts": "app\n",
      "packages/other/index.ts": "other\n",
    });
    const ws = path.join(repo, "packages/app");
    await write(ws, "node_modules/dep/index.js", "dep\n");
    await write(ws, "build/out.js", "out\n");
    await write(ws, "scratch.tmp", "tmp\n");
    const first = await okSnap(ws);
    const files = shadowGit(ws, "ls-tree", "-r", "--name-only", first.commit).trim().split("\n");
    expect(files).toEqual(["index.ts"]);
    await write(ws, "index.ts", "app v2\n");
    await write(ws, "build/out.js", "out v2\n");
    const restored = await restore(ws, first);
    expect(restored.verification?.ok).toBe(true);
    expect(await readFile(path.join(ws, "index.ts"), "utf8")).toBe("app\n");
    expect(await readFile(path.join(ws, "build/out.js"), "utf8")).toBe("out v2\n");
  });

  it("does not follow the user's info/exclude out of scope and does honor it", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "a\n" });
    await writeFile(path.join(ws, ".git/info/exclude"), "local-only/\n");
    await write(ws, "local-only/data.txt", "private\n");
    const first = await okSnap(ws);
    expect(shadowGit(ws, "ls-tree", "-r", "--name-only", first.commit)).not.toContain("local-only");
    await restore(ws, first);
    expect(await readFile(path.join(ws, "local-only/data.txt"), "utf8")).toBe("private\n");
  });
});

describe("bb's chat storage", () => {
  /** git in the shadow with the workspace as work tree, as the host runs it. */
  function shadowWorkTreeGit(workspace: string, ...args: string[]): string {
    const gitDir = path.join(dataDir, "shadows", shadowKey(workspace), "git");
    return execFileSync("git", [`--git-dir=${gitDir}`, `--work-tree=${workspace}`, "-c", "core.bare=false", ...args], {
      cwd: workspace,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
  }
  const treePaths = (workspace: string, tree: string) => shadowGit(workspace, "ls-tree", "-r", "--name-only", tree).split("\n").filter(Boolean).sort();

  it("never captures .bb/chats, even files the repository tracks, but captures the rest of .bb/", async () => {
    const ws = await tempDir("ws");
    // The repository ignores the folder, yet commits one chat copy anyway.
    await initRepo(ws, { "a.txt": "one\n", ".gitignore": ".bb/chats/\n" });
    await write(ws, ".bb/chats/thr_tracked/thread.json", "{}\n");
    userGit(ws, "add", "-f", ".bb/chats/thr_tracked/thread.json");
    userGit(ws, "commit", "-q", "-m", "track a chat copy");
    await write(ws, ".bb/plugins.json", '{"rewind":true}\n');
    await write(ws, ".bb/chats/thr_1/thread.json", '{"title":"one"}\n');
    await write(ws, ".bb/chats/thr_1/history/index.json", "[]\n");
    await write(ws, ".bb/chatsworth.txt", "not a chat copy\n");
    const first = await okSnap(ws);
    expect(treePaths(ws, first.tree)).toEqual([".bb/chatsworth.txt", ".bb/plugins.json", ".gitignore", "a.txt"]);
    expect(first.changes.map((change) => change.path).filter((file) => file.startsWith(".bb/chats/"))).toEqual([]);

    // bb rewrites its copies after every turn: that alone changes nothing.
    await write(ws, ".bb/chats/thr_1/thread.json", '{"title":"renamed"}\n');
    await write(ws, ".bb/chats/thr_1/history/turn_2/page-1.json", "[]\n");
    await write(ws, ".bb/chats/thr_tracked/thread.json", "{\"changed\":true}\n");
    const second = await okSnap(ws, { compareTo: first.commit });
    expect(second.deduped).toBe(true);

    await write(ws, ".bb/plugins.json", '{"rewind":false}\n');
    await write(ws, ".bb/chats/thr_1/thread.json", '{"title":"again"}\n');
    const third = await okSnap(ws, { compareTo: first.commit });
    expect(third.changes.map((change) => [change.path, change.status])).toEqual([[".bb/plugins.json", "M"]]);
    expect(third.stats.files).toBe(1);
  });

  it("drops chat copies an earlier version captured, and never restores or deletes them from an old checkpoint", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "one\n", ".bb/plugins.json": "{}\n" });
    await write(ws, ".bb/chats/thr_old/thread.json", "v1\n");
    await write(ws, ".bb/chats/thr_gone/thread.json", "gone\n");
    await okSnap(ws);

    // What Rewind 0.1 left behind: chat copies in the shadow index, in the
    // latest checkpoint's tree, and no exclusion for them.
    shadowWorkTreeGit(ws, "update-index", "--add", "--", ".bb/chats/thr_old/thread.json", ".bb/chats/thr_gone/thread.json");
    const oldTree = shadowWorkTreeGit(ws, "write-tree").trim();
    const oldCommit = shadowGit(ws, "commit-tree", "-m", "old", oldTree).trim();
    const old = { checkpointId: newId("ck"), commit: oldCommit };
    shadowGit(ws, "update-ref", `refs/rewind/${old.checkpointId}`, oldCommit);
    expect(treePaths(ws, oldTree)).toContain(".bb/chats/thr_old/thread.json");
    const shadowRoot = path.join(dataDir, "shadows", shadowKey(ws));
    const state = JSON.parse(await readFile(path.join(shadowRoot, "state.json"), "utf8")) as Record<string, unknown>;
    await writeFile(path.join(shadowRoot, "state.json"), JSON.stringify({ ...state, lastTree: oldTree, lastCommit: oldCommit }));
    const excludeFile = path.join(shadowRoot, "git", "info", "exclude");
    await writeFile(excludeFile, (await readFile(excludeFile, "utf8")).replace("/.bb/chats/\n", ""));

    // The next snapshot drops them from the index; its changes do not show it.
    const next = await okSnap(ws, { compareTo: oldCommit });
    expect(treePaths(ws, next.tree)).toEqual([".bb/plugins.json", "a.txt"]);
    expect(shadowWorkTreeGit(ws, "ls-files").split("\n").filter(Boolean).sort()).toEqual([".bb/plugins.json", "a.txt"]);
    expect(next.changes).toEqual([]);
    expect(await readFile(excludeFile, "utf8")).toContain("/.bb/chats/\n");

    // bb keeps writing its copies; one chat was deleted, one started.
    await write(ws, "a.txt", "two\n");
    await write(ws, ".bb/chats/thr_old/thread.json", "v2\n");
    await rm(path.join(ws, ".bb/chats/thr_gone"), { recursive: true });
    await write(ws, ".bb/chats/thr_new/thread.json", "new\n");

    const plan = await restore(ws, old, { dryRun: true });
    expect(plan.plan.changes.map((change) => [change.path, change.action])).toEqual([["a.txt", "write"]]);
    expect(plan.plan.protectedCount).toBe(0);

    const restored = await restore(ws, old);
    expect(restored.verification?.ok).toBe(true);
    expect(await readFile(path.join(ws, "a.txt"), "utf8")).toBe("one\n");
    expect(await readFile(path.join(ws, ".bb/chats/thr_old/thread.json"), "utf8")).toBe("v2\n");
    expect(await exists(path.join(ws, ".bb/chats/thr_gone/thread.json"))).toBe(false);
    expect(await readFile(path.join(ws, ".bb/chats/thr_new/thread.json"), "utf8")).toBe("new\n");
    expect(await readFile(path.join(ws, ".bb/plugins.json"), "utf8")).toBe("{}\n");
    expect(treePaths(ws, restored.effectiveTree)).toEqual([".bb/plugins.json", "a.txt"]);

    // Undo puts a.txt back and still leaves the copies alone.
    const undo = await restore(ws, { checkpointId: restored.preRestoreId, commit: restored.preRestore!.commit });
    expect(undo.verification?.ok).toBe(true);
    expect(await readFile(path.join(ws, "a.txt"), "utf8")).toBe("two\n");
    expect(await readFile(path.join(ws, ".bb/chats/thr_old/thread.json"), "utf8")).toBe("v2\n");
    expect(await readFile(path.join(ws, ".bb/chats/thr_new/thread.json"), "utf8")).toBe("new\n");
  });

  it("hides chat copies from diffs between old checkpoints", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "one\n" });
    const first = await okSnap(ws);
    await write(ws, ".bb/chats/thr_1/thread.json", "{}\n");
    shadowWorkTreeGit(ws, "update-index", "--add", "--", ".bb/chats/thr_1/thread.json");
    await write(ws, "a.txt", "two\n");
    shadowWorkTreeGit(ws, "update-index", "--", "a.txt");
    const oldCommit = shadowGit(ws, "commit-tree", "-m", "old", shadowWorkTreeGit(ws, "write-tree").trim()).trim();
    const oldId = newId("ck");
    shadowGit(ws, "update-ref", `refs/rewind/${oldId}`, oldCommit);
    const diff = await harness.experimental_call("diff", {
      workspace: ws,
      from: { kind: "checkpoint", commit: first.commit, checkpointId: first.checkpointId },
      to: { kind: "checkpoint", commit: oldCommit, checkpointId: oldId },
      paths: null,
      patch: true,
      maxFiles: 100,
      maxPatchBytesPerFile: 65_536,
      maxPatchBytesTotal: 262_144,
      limits: LIMITS,
    });
    if (diff.status !== "ok") throw new Error(JSON.stringify(diff));
    expect(diff.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(diff.totalFiles).toBe(1);
    expect(diff.stats.files).toBe(1);
  });

  it("leaves bb thread storage inside the workspace alone, and remembers it for later calls", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "one\n" });
    await write(ws, "chat-store/thr_9/thread.json", "{}\n");
    await write(ws, "chat-store-notes.txt", "user file\n");
    // The workspace itself and paths outside it are never excluded.
    const first = await okSnap(ws, { excludePaths: [path.join(ws, "chat-store", "thr_9"), ws, path.dirname(ws), path.join(path.dirname(ws), "elsewhere")] });
    expect(treePaths(ws, first.tree)).toEqual(["a.txt", "chat-store-notes.txt"]);

    await write(ws, "chat-store/thr_9/thread.json", '{"changed":true}\n');
    const second = await okSnap(ws, { compareTo: first.commit });
    expect(second.deduped).toBe(true);

    await write(ws, "a.txt", "two\n");
    const restored = await restore(ws, first);
    expect(restored.verification?.ok).toBe(true);
    expect(await readFile(path.join(ws, "a.txt"), "utf8")).toBe("one\n");
    expect(await readFile(path.join(ws, "chat-store/thr_9/thread.json"), "utf8")).toBe('{"changed":true}\n');
  });
});

describe("hostile workspaces", () => {
  it.skipIf(!POSIX)("never writes through a symlink that replaced a directory", async () => {
    const ws = await tempDir("ws");
    const outside = await tempDir("outside");
    await write(outside, "precious.txt", "outside the workspace\n");
    await initRepo(ws, { "dir/secret.txt": "inside\n" });
    const first = await okSnap(ws);
    await rm(path.join(ws, "dir"), { recursive: true });
    await symlink(outside, path.join(ws, "dir"));
    await okSnap(ws);
    const restored = await restore(ws, first);
    expect(restored.verification?.ok).toBe(true);
    expect((await lstat(path.join(ws, "dir"))).isDirectory()).toBe(true);
    expect(await readFile(path.join(ws, "dir/secret.txt"), "utf8")).toBe("inside\n");
    expect(treeToObject(await snapshotTree(outside))).toEqual({
      "precious.txt": expect.objectContaining({ type: "file", size: 22 }),
    });
  });

  it.skipIf(!POSIX)("protects paths behind an uncaptured symlink", async () => {
    const ws = await tempDir("ws");
    const outside = await tempDir("outside");
    await initRepo(ws, { "a.txt": "a\n", "linked/file.txt": "was a real dir\n" });
    const first = await okSnap(ws);
    await rm(path.join(ws, "linked"), { recursive: true });
    await write(ws, ".gitignore", "linked\n");
    await symlink(outside, path.join(ws, "linked"));
    await okSnap(ws);
    const restored = await restore(ws, first);
    expect(restored.plan.protected).toContainEqual(expect.objectContaining({ path: "linked/file.txt", action: "create" }));
    expect(treeToObject(await snapshotTree(outside))).toEqual({});
    expect(restored.verification?.ok).toBe(true);
  });

  it("stores bytes exactly despite .gitattributes line-ending and filter rules", async () => {
    const ws = await tempDir("ws");
    await write(ws, ".gitattributes", "* text eol=lf\n*.txt filter=lfs diff=lfs merge=lfs\n");
    await write(ws, "crlf.txt", "one\r\ntwo\r\n");
    await write(ws, "mixed.md", "a\r\nb\nc\r");
    const before = await snapshotTree(ws);
    const first = await okSnap(ws);
    await write(ws, "crlf.txt", "changed\n");
    await write(ws, "mixed.md", "changed\n");
    const restored = await restore(ws, first);
    expect(restored.verification?.ok).toBe(true);
    expect(treeToObject(await snapshotTree(ws))).toEqual(treeToObject(before));
    expect(await readFile(path.join(ws, "crlf.txt"), "latin1")).toBe("one\r\ntwo\r\n");
  });

  it.skipIf(!POSIX)("skips a file it cannot read instead of failing the snapshot", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "a\n" });
    await write(ws, "locked.txt", "no read permission\n");
    await chmod(path.join(ws, "locked.txt"), 0o000);
    try {
      const { result } = await snap(ws);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.skipped).toContainEqual(expect.objectContaining({ path: "locked.txt", reason: "unreadable" }));
      }
    } finally {
      await chmod(path.join(ws, "locked.txt"), 0o644);
    }
  });
});

describe("limits and store management", () => {
  it("marks a workspace over the file cap unsupported until forced", async () => {
    const ws = await tempDir("ws");
    for (let index = 0; index < 12; index += 1) await write(ws, `f${index}.txt`, `${index}\n`);
    const limits = { ...LIMITS, maxFiles: 5 };
    const { result } = await snap(ws, { limits });
    expect(result).toMatchObject({ status: "unsupported" });
    const again = await snap(ws, { limits: LIMITS });
    expect(again.result.status).toBe("unsupported"); // remembered for an hour
    const forced = await snap(ws, { limits: LIMITS, force: true });
    expect(forced.result.status).toBe("ok");
  });

  it.skipIf(!POSIX)("returns per-file patches for diffs, including binary and type changes", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "one\ntwo\nthree\n", "t.txt": "file\n" });
    const first = await okSnap(ws);
    await write(ws, "a.txt", "one\n2\nthree\n");
    await write(ws, "bin.dat", Buffer.from([0, 0, 1, 2]));
    await unlink(path.join(ws, "t.txt"));
    await symlink("a.txt", path.join(ws, "t.txt"));
    const second = await okSnap(ws);
    const diff = await harness.experimental_call("diff", {
      workspace: ws,
      from: { kind: "checkpoint", commit: first.commit, checkpointId: first.checkpointId },
      to: { kind: "checkpoint", commit: second.commit, checkpointId: second.checkpointId },
      paths: null,
      patch: true,
      maxFiles: 100,
      maxPatchBytesPerFile: 64 * 1024,
      maxPatchBytesTotal: 1024 * 1024,
      limits: LIMITS,
    });
    if (diff.status !== "ok") throw new Error(JSON.stringify(diff));
    expect(diff.files.map((file) => [file.path, file.status])).toEqual([
      ["a.txt", "M"],
      ["bin.dat", "A"],
      ["t.txt", "T"],
    ]);
    const a = diff.files[0]!;
    expect(a.patch).toContain("-two");
    expect(a.patch).toContain("+2");
    expect(a.patch?.startsWith("diff --git a/a.txt b/a.txt")).toBe(true);
    expect(diff.files[1]!.binary).toBe(true);
    expect(diff.files[2]!.patch).toContain("new file mode 120000");
    // bin.dat is binary (no line counts); the type change counts one line each way.
    expect(diff.stats).toEqual({ files: 3, insertions: 2, deletions: 2 });

    // Current workspace against a checkpoint, one path only.
    await write(ws, "a.txt", "changed again\n");
    const live = await harness.experimental_call("diff", {
      workspace: ws,
      from: { kind: "checkpoint", commit: second.commit, checkpointId: second.checkpointId },
      to: { kind: "workspace" },
      paths: ["a.txt"],
      patch: true,
      maxFiles: 10,
      maxPatchBytesPerFile: 64 * 1024,
      maxPatchBytesTotal: 1024 * 1024,
      limits: LIMITS,
    });
    if (live.status !== "ok") throw new Error(JSON.stringify(live));
    expect(live.files).toHaveLength(1);
    expect(live.files[0]!.patch).toContain("+changed again");
  });

  it("restores another workspace's checkpoint into a fresh worktree (fork with files)", async () => {
    const source = await tempDir("source");
    await initRepo(source, { "a.txt": "base\n", ".gitignore": ".env\n" });
    await write(source, "a.txt", "work in progress\n");
    await write(source, "new.txt", "created by the agent\n");
    const checkpoint = await okSnap(source);
    const expected = await snapshotTree(source);
    await write(source, "a.txt", "later work\n");

    const worktreeParent = await tempDir("wt");
    const fork = path.join(worktreeParent, "fork");
    userGit(source, "worktree", "add", "-q", "-b", "fork-branch", fork);
    await write(fork, ".env", "copied by .worktreeinclude\n");
    const restored = await restore(fork, checkpoint, { sourceWorkspace: source });
    expect(restored.verification?.ok).toBe(true);
    expect(treeToObject(await snapshotTree(fork, { skip: (relative) => relative === ".env" }))).toEqual(treeToObject(expected));
    expect(await readFile(path.join(fork, ".env"), "utf8")).toBe("copied by .worktreeinclude\n");
    expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("later work\n");
  });

  it("deletes checkpoint refs and reconciles unknown ones", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "a\n" });
    const one = await okSnap(ws);
    await write(ws, "a.txt", "b\n");
    const two = await okSnap(ws);
    const deleted = await harness.experimental_call("deleteRefs", { workspace: ws, checkpointIds: [one.checkpointId, newId("ck")] });
    expect(deleted.deleted).toBe(1);
    const reconcile = await harness.experimental_call("reconcile", { workspace: ws, keepCheckpointIds: [], minAgeMs: 0, gc: true });
    expect(reconcile).toMatchObject({ deletedRefs: 1, gcRan: true });
    expect(shadowGit(ws, "for-each-ref", "refs/rewind/").trim()).toBe("");
    const status = await harness.experimental_call("status", { workspace: ws, measureSize: true });
    expect(status).toMatchObject({ workspaceExists: true, shadowExists: true, refCount: 0 });
    void two;
  });

  it("keeps refs younger than the reconcile grace period", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "a\n" });
    await okSnap(ws);
    const reconcile = await harness.experimental_call("reconcile", { workspace: ws, keepCheckpointIds: [], minAgeMs: 60 * 60 * 1000, gc: false });
    expect(reconcile.deletedRefs).toBe(0);
  });

  it("lists and removes shadows", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "a\n" });
    await okSnap(ws);
    const { shadows } = await harness.experimental_call("listShadows", {});
    expect(shadows).toHaveLength(1);
    expect(shadows[0]!.workspace).toBe(ws);
    expect(await harness.experimental_call("removeShadow", { key: shadows[0]!.key })).toEqual({ removed: true });
    expect((await harness.experimental_call("listShadows", {})).shadows).toHaveLength(0);
    expect((await stat(ws)).isDirectory()).toBe(true);
  });
});

describe("workspaces that change under the snapshot", () => {
  it.skipIf(!POSIX)("drops a captured file that turned into a directory or became unreadable, without failing", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { thing: "a file\n", "locked.txt": "readable\n", "a.txt": "a\n" });
    const first = await okSnap(ws);
    await rm(path.join(ws, "thing"));
    await write(ws, "thing/inner.txt", "now a directory\n");
    await chmod(path.join(ws, "locked.txt"), 0o000);
    try {
      const second = await okSnap(ws);
      const names = shadowGit(ws, "ls-tree", "-r", "--name-only", second.commit).trim().split("\n");
      expect(names).toContain("thing/inner.txt");
      expect(names).not.toContain("thing");
      expect(names).not.toContain("locked.txt");
      expect(second.skipped).toContainEqual(expect.objectContaining({ path: "locked.txt", reason: "unreadable" }));

      // Back to the first checkpoint: the directory becomes the file again,
      // and the file Rewind cannot read is left as it is.
      const restored = await restore(ws, first);
      expect(restored.verification?.ok).toBe(true);
      expect(await readFile(path.join(ws, "thing"), "utf8")).toBe("a file\n");
      expect(restored.plan.protected).toContainEqual(expect.objectContaining({ path: "locked.txt" }));
    } finally {
      await chmod(path.join(ws, "locked.txt"), 0o644);
    }
  });

  it.skipIf(!POSIX)("skips many unreadable files in one snapshot", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "a\n" });
    const locked = Array.from({ length: 12 }, (_, index) => `locked-${index.toString().padStart(2, "0")}.txt`);
    for (const name of locked) {
      await write(ws, name, `${name}\n`);
      await chmod(path.join(ws, name), 0o000);
    }
    try {
      const { result } = await snap(ws);
      if (result.status !== "ok") throw new Error(JSON.stringify(result));
      expect(result.skipped.filter((entry) => entry.reason === "unreadable").map((entry) => entry.path).sort()).toEqual(locked);
    } finally {
      for (const name of locked) await chmod(path.join(ws, name), 0o644);
    }
  });

  it("applies the size cap to what each snapshot adds, not only to the first", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "a\n" });
    const limits = { ...LIMITS, maxTotalBytes: 64 * 1024 };
    await okSnap(ws, { limits });
    for (let index = 0; index < 4; index += 1) await write(ws, `download-${index}.bin`, Buffer.alloc(32 * 1024, index));
    const { result } = await snap(ws, { limits });
    expect(result).toMatchObject({ status: "unsupported", reason: "more than 64 KB of new or changed files to capture" });
  });

  it("honors the user's global excludes file in a workspace that is not a git repository", async () => {
    const home = await tempDir("home");
    await write(home, "ignore-rules", "*.secret\n");
    // Forward slashes: git reads backslashes in config values as escapes.
    await write(home, ".gitconfig", `[core]\n\texcludesFile = ${path.join(home, "ignore-rules").replaceAll("\\", "/")}\n`);
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    resetGitBaseEnv();
    clearUserRepoCaches();
    try {
      const ws = await tempDir("plain");
      await write(ws, "notes.md", "notes\n");
      await write(ws, "api.secret", "token\n");
      const first = await okSnap(ws);
      expect(shadowGit(ws, "ls-tree", "-r", "--name-only", first.commit).trim()).toBe("notes.md");
      await write(ws, "notes.md", "edited\n");
      await write(ws, "api.secret", "rotated\n");
      const restored = await restore(ws, first);
      expect(restored.verification?.ok).toBe(true);
      expect(await readFile(path.join(ws, "notes.md"), "utf8")).toBe("notes\n");
      expect(await readFile(path.join(ws, "api.secret"), "utf8")).toBe("rotated\n");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      resetGitBaseEnv();
      clearUserRepoCaches();
    }
  });
});

describe("restores that go wrong", () => {
  it.for(["EACCES", "corrupt-store", "dangling-ref", "noncommit-ref", "malformed-ref", "unreadable-ref", "corrupt-packed", "unreadable-packed"])("U02 rejects unavailable saved Undo refs instead of reporting absence (%s)", async (failure, context) => {
    if (!POSIX && failure.startsWith("unreadable-")) context.skip();
    const ws = await tempDir("ws"); await write(ws, "a.txt", "old\n");
    const old = await okSnap(ws); await write(ws, "a.txt", "before restore\n");
    const applied = await restore(ws, old);
    expect(await readFile(path.join(ws, "a.txt"), "utf8")).toBe("old\n");
    const gitDir = path.join(dataDir, "shadows", shadowKey(ws), "git");
    const lookup = { workspace: ws, checkpointId: applied.preRestoreId };
    const saved = await harness.experimental_call("refCommit", lookup);
    expect(saved.commit).toBe(applied.preRestore?.commit);
    const realLstat = fsPromises.lstat;
    let denied: { mockRestore(): void } | undefined;
    try {
      if (failure === "EACCES") {
        denied = vi.spyOn(fsPromises, "lstat").mockImplementation((async (...args: Parameters<typeof realLstat>) => {
          if (String(args[0]).startsWith(gitDir)) throw Object.assign(new Error("test shadow inaccessible"), { code: "EACCES" });
          return realLstat(...args);
        }) as typeof realLstat); syncBuiltinESMExports();
      } else if (failure === "corrupt-store") await writeFile(path.join(gitDir, "HEAD"), "not a Git HEAD\n");
      else if (failure === "unreadable-ref") await chmod(path.join(gitDir, "refs", "rewind", applied.preRestoreId), 0o000);
      else if (failure.endsWith("-packed")) {
        shadowGit(ws, "pack-refs", "--all", "--prune");
        if (failure === "corrupt-packed") await writeFile(path.join(gitDir, "packed-refs"), "broken packed ref\n");
        else await chmod(path.join(gitDir, "packed-refs"), 0o000);
      } else await writeFile(path.join(gitDir, "refs", "rewind", applied.preRestoreId), `${failure === "malformed-ref" ? "broken" : failure === "dangling-ref" ? "f".repeat(40) : saved.tree}\n`);
      await expect(harness.experimental_call("refCommit", lookup)).rejects.toThrow();
    } finally {
      denied?.mockRestore(); syncBuiltinESMExports();
      if (failure === "unreadable-ref") await chmod(path.join(gitDir, "refs", "rewind", applied.preRestoreId), 0o644);
      if (failure === "unreadable-packed") await chmod(path.join(gitDir, "packed-refs"), 0o644);
    }
  });
  it("U02 reports authoritative absence for an uncreated shadow store", async () => {
    const ws = await tempDir("ws");
    expect(await harness.experimental_call("refCommit", { workspace: ws, checkpointId: newId("ck") })).toEqual({ commit: null, tree: null });
  });
  it.skipIf(!POSIX)("reports a restore that stopped part way with an undo point that puts every file back", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "a0\n", "locked/b.txt": "b0\n" });
    const first = await okSnap(ws);
    await write(ws, "a.txt", "a1\n");
    await write(ws, "locked/b.txt", "b1\n");
    const before = await snapshotTree(ws);
    // Files in a read-only directory cannot be replaced, so the restore fails
    // after it has already written a.txt.
    await chmod(path.join(ws, "locked"), 0o555);
    try {
      const preRestoreId = newId("ck");
      const result = await harness.experimental_call("restore", {
        workspace: ws,
        target: { commit: first.commit, checkpointId: first.checkpointId, sourceWorkspace: null },
        dryRun: false,
        preRestore: { checkpointId: preRestoreId, subject: "pre-restore" },
        limits: LIMITS,
        maxListed: 500,
      });
      if (result.status !== "ok") throw new Error(JSON.stringify(result));
      expect(result.applied).toBe(true);
      expect(result.applyError).toMatch(/read-tree/u);
      expect(result.verification).toBeNull();
      expect(await readFile(path.join(ws, "a.txt"), "utf8")).toBe("a0\n");
      expect(await readFile(path.join(ws, "locked/b.txt"), "utf8")).toBe("b1\n");

      // The next snapshot compares against the undo point: one file changed.
      const next = await okSnap(ws);
      expect(next.comparedTo).toBe(result.preRestore?.tree);
      expect(next.changes.map((change) => change.path)).toEqual(["a.txt"]);

      const ref = await harness.experimental_call("refCommit", { workspace: ws, checkpointId: preRestoreId });
      expect(ref.commit).toBe(result.preRestore?.commit);
      const undone = await restore(ws, { checkpointId: preRestoreId, commit: ref.commit! });
      expect(undone.applyError).toBeNull();
      expect(undone.verification?.ok).toBe(true);
      expect(treeToObject(await snapshotTree(ws))).toEqual(treeToObject(before));
    } finally {
      await chmod(path.join(ws, "locked"), 0o755);
    }
  });

  it.skipIf(!POSIX)("retries a restore that hit a locked file, and finishes once the file is free", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "a0\n", "locked/b.txt": "b0\n" });
    const first = await okSnap(ws);
    await write(ws, "a.txt", "a1\n");
    await write(ws, "locked/b.txt", "b1\n");
    await chmod(path.join(ws, "locked"), 0o555);
    try {
      const pending = restore(ws, first);
      // The first attempt writes a.txt, then fails on the locked folder.
      await until(async () => (await readFile(path.join(ws, "a.txt"), "utf8")) === "a0\n");
      await chmod(path.join(ws, "locked"), 0o755);
      const restored = await pending;
      expect(restored.applyError).toBeNull();
      expect(restored.verification?.ok).toBe(true);
      expect(await readFile(path.join(ws, "locked/b.txt"), "utf8")).toBe("b0\n");
    } finally {
      await chmod(path.join(ws, "locked"), 0o755);
    }
  });

  it("finds no undo point for a checkpoint id that was never taken", async () => {
    const ws = await tempDir("ws");
    await initRepo(ws, { "a.txt": "a\n" });
    await okSnap(ws);
    expect(await harness.experimental_call("refCommit", { workspace: ws, checkpointId: newId("ck") })).toEqual({ commit: null, tree: null });
  });

  it("verifies a restore that changes only the case of a file name", async () => {
    const source = await tempDir("source");
    await initRepo(source, { "README.md": "upper\n" });
    const checkpoint = await okSnap(source);
    const target = await tempDir("target");
    await initRepo(target, { "readme.md": "lower\n" });
    const restored = await restore(target, checkpoint, { sourceWorkspace: source });
    expect(restored.verification?.ok).toBe(true);
    expect((await readdir(target)).filter((name) => name.toLowerCase() === "readme.md")).toEqual(["README.md"]);
    expect(await readFile(path.join(target, "README.md"), "utf8")).toBe("upper\n");
  });

  it("explains why a checkpoint from another workspace cannot be copied", async () => {
    const source = await tempDir("source");
    await initRepo(source, { "a.txt": "a\n" });
    const checkpoint = await okSnap(source);
    await harness.experimental_call("deleteRefs", { workspace: source, checkpointIds: [checkpoint.checkpointId] });
    const target = await tempDir("target");
    await initRepo(target, { "a.txt": "b\n" });
    const result = await harness.experimental_call("restore", {
      workspace: target,
      target: { commit: checkpoint.commit, checkpointId: checkpoint.checkpointId, sourceWorkspace: source },
      dryRun: true,
      preRestore: null,
      limits: LIMITS,
      maxListed: 500,
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") expect(result.reason).toMatch(/copying it from .+ failed: git fetch exited \d+: .*refs\/rewind\//u);
  });
});
