import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hostEntry from "../../host";
import { newId } from "../../src/ids";
import { ObjectPool } from "../../src/host/pool";
import { poolPaths, withPoolRead, withPoolWrite } from "../../src/host/pool-coordination";
import { directorySize, Shadow, shadowKey } from "../../src/host/shadow";
import { clearUserRepoCaches } from "../../src/host/user-repo";
import { exists, fingerprint, initRepo, removeTempDirs, snapshotTree, tempDir, write } from "../helpers/fs";

const limits = { maxFileBytes: 10 * 1024 * 1024, maxFiles: 100_000, maxTotalBytes: 2 * 1024 ** 3 };
let dataDir: string;
function makeHarness(dataDir: string, tempDir: string) {
  return experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir } });
}
let harness: ReturnType<typeof makeHarness>;

beforeEach(async () => {
  clearUserRepoCaches();
  dataDir = await tempDir("pool-data");
  harness = makeHarness(dataDir, await tempDir("tmp"));
});
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); await harness.experimental_dispose(); await removeTempDirs(); });

function git(ws: string, ...args: string[]) {
  return execFileSync("git", [`--git-dir=${path.join(dataDir, "shadows", shadowKey(ws), "git")}`, ...args], { encoding: "utf8", input: "", timeout: 20_000 }).trim();
}
function poolGit(...args: string[]) {
  return execFileSync("git", [`--git-dir=${poolPaths(dataDir).git}`, ...args], { encoding: "utf8", input: "", timeout: 20_000 }).trim();
}
async function snap(workspace: string) {
  const checkpointId = newId("ck");
  const result = await harness.experimental_call("snapshot", { workspace, checkpointId, kind: "manual", subject: "pool test", compareTo: null, limits, force: false });
  if (result.status !== "ok") throw new Error(JSON.stringify(result));
  return { checkpointId, ...result };
}
async function migrate(workspaces: string[] | null = null, dryRun = false) {
  return harness.experimental_call("pool", { workspaces, gc: false, dryRun });
}
async function gc(dryRun = false) { return harness.experimental_call("pool", { workspaces: null, gc: true, dryRun }); }
async function restore(workspace: string, checkpoint: { checkpointId: string; commit: string }, sourceWorkspace: string | null = null) {
  const preRestore = { checkpointId: newId("ck"), subject: "pool Undo" };
  const result = await harness.experimental_call("restore", { workspace, target: { checkpointId: checkpoint.checkpointId, commit: checkpoint.commit, sourceWorkspace }, dryRun: false, preRestore, limits, maxListed: 100 });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error(JSON.stringify(result));
  expect(result.verification?.ok).toBe(true);
  return preRestore.checkpointId;
}

describe("shared object pool", () => {
  it("previews without writing and leaves legacy stores independent until migration", async () => {
    const ws = await tempDir("ws"); await write(ws, "a", "original"); await snap(ws);
    const before = await fingerprint(dataDir);
    expect(await migrate(null, true)).toMatchObject({ stores: 1, migrated: 0, members: 0 });
    expect(await gc(true)).toMatchObject({ gcRan: false });
    expect(await fingerprint(dataDir)).toBe(before);
    expect(await exists(poolPaths(dataDir).root)).toBe(false);
    expect(git(ws, "fsck", "--full", "--no-dangling")).toBe("");
  });

  it("deduplicates real Git stores while preserving every ref/object, user Git, restores and Undo", async () => {
    const a = await tempDir("a"), b = await tempDir("b"), bytes = randomBytes(512 * 1024);
    const snapshots = [];
    for (const ws of [a, b]) {
      await initRepo(ws, { a: "original" }); await write(ws, "common.bin", bytes);
      snapshots.push(await snap(ws));
      git(ws, "hash-object", "-w", "--stdin"); // Unreachable loose object.
      git(ws, "repack", "-a", "-d", "--keep-unreachable");
    }
    const refs = [a, b].map(ws => git(ws, "for-each-ref"));
    const objects = [a, b].map(ws => git(ws, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)").split("\n"));
    const user = await Promise.all([a, b].map(ws => fingerprint(path.join(ws, ".git"))));
    const trees = await Promise.all([a, b].map(ws => snapshotTree(ws)));
    const result = await migrate();
    expect(result).toMatchObject({ stores: 2, migrated: 2, members: 2 });
    expect(result.afterBytes!).toBeLessThan(result.beforeBytes! * 0.75);
    for (const [i, ws] of [a, b].entries()) {
      expect(git(ws, "for-each-ref")).toBe(refs[i]);
      const after = new Set(git(ws, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)").split("\n"));
      for (const oid of objects[i]!) expect(after.has(oid)).toBe(true);
      expect(git(ws, "fsck", "--full", "--no-dangling")).toBe("");
      expect(await fingerprint(path.join(ws, ".git"))).toBe(user[i]); expect(await snapshotTree(ws)).toEqual(trees[i]);
    }
    await write(b, "a", "edited");
    const undo = await restore(b, snapshots[1]!);
    expect(await fs.readFile(path.join(b, "a"), "utf8")).toBe("original");
    await gc();
    const anchor = await harness.experimental_call("refCommit", { workspace: b, checkpointId: undo });
    expect(anchor.commit).not.toBeNull();
    await restore(b, { checkpointId: undo, commit: anchor.commit! });
    expect(await fs.readFile(path.join(b, "a"), "utf8")).toBe("edited");
  });

  it("keeps another member usable after the source workspace/store disappears", async () => {
    const a = await tempDir("a"), b = await tempDir("b");
    await write(a, "a", "shared"); await write(b, "a", "shared"); await snap(a); const saved = await snap(b);
    await migrate(); await fs.rm(a, { recursive: true, force: true });
    await harness.experimental_call("removeShadow", { key: shadowKey(a) });
    expect(await gc()).toMatchObject({ gcRan: true, members: 1 });
    await write(b, "a", "changed"); await restore(b, saved);
    expect(await fs.readFile(path.join(b, "a"), "utf8")).toBe("shared");
  });

  it("resumes after a failed copy, retaining standalone stores and refusing GC meanwhile", async () => {
    const ws = await tempDir("ws"); await write(ws, "a", randomBytes(8192)); await snap(ws);
    const refs = git(ws, "for-each-ref"), original = await snapshotTree(ws);
    const copy = fs.copyFile;
    const spy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args: Parameters<typeof copy>) => {
      if (String(args[1]).includes("object-pool")) throw new Error("injected copy failure");
      return copy(...args);
    }); syncBuiltinESMExports();
    try { await expect(migrate()).rejects.toThrow("injected copy failure"); } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(git(ws, "for-each-ref")).toBe(refs);
    expect(git(ws, "fsck", "--full", "--no-dangling")).toBe("");
    expect(await snapshotTree(ws)).toEqual(original);
    expect(await exists(path.join(dataDir, "shadows", shadowKey(ws), "git", "objects", "info", "alternates"))).toBe(false);
    await expect(gc()).rejects.toThrow(/incomplete/u);
    expect(await migrate()).toMatchObject({ migrated: 1 });
    expect(await gc()).toMatchObject({ gcRan: true });
  });

  it("finishes an interrupted owned pool initialization and rejects foreign alternates", async () => {
    const ws = await tempDir("ws"); await write(ws, "a", "kept"); await snap(ws);
    const paths = poolPaths(dataDir);
    await fs.mkdir(paths.git, { recursive: true }); await fs.writeFile(paths.marker, JSON.stringify({ version: 1 }));
    expect(await migrate()).toMatchObject({ migrated: 1 });
    const alternate = path.join(dataDir, "shadows", shadowKey(ws), "git", "objects", "info", "alternates");
    const original = await fs.readFile(alternate, "utf8");
    await fs.writeFile(alternate, "/not-rewind/objects\n");
    const before = await fingerprint(paths.git);
    await expect(gc()).rejects.toThrow(/Unexpected/u); await expect(migrate()).rejects.toThrow(/Unexpected/u);
    expect(await fingerprint(paths.git)).toBe(before);
    await fs.writeFile(alternate, original); await gc();
  });

  it("keeps linked stores readable after cleanup failure and resumes after a worker reload", async () => {
    const ws = await tempDir("ws"); await write(ws, "a", "original"); const saved = await snap(ws);
    const bare = Shadow.prototype.bare;
    const spy = vi.spyOn(Shadow.prototype, "bare").mockImplementation(function (this: Shadow, args, options) {
      if (args.includes("repack") && args.includes("--local")) return Promise.reject(new Error("injected cleanup failure"));
      return bare.call(this, args, options);
    });
    try { await expect(migrate()).rejects.toThrow("injected cleanup failure"); } finally { spy.mockRestore(); }
    await harness.experimental_dispose();
    harness = makeHarness(dataDir, await tempDir("tmp"));
    expect((await harness.experimental_call("refCommit", { workspace: ws, checkpointId: saved.checkpointId })).commit).toBe(saved.commit);
    await expect(gc()).rejects.toThrow(/incomplete/u);
    expect(await migrate()).toMatchObject({ migrated: 1 });
    await gc(); expect(git(ws, "fsck", "--full", "--no-dangling")).toBe("");
  });

  it("refuses GC for a corrupt/missing member journal or state and an unregistered borrower", async () => {
    const ws = await tempDir("ws"); await write(ws, "a", "kept"); await snap(ws); await migrate();
    const journal = path.join(poolPaths(dataDir).members, `${shadowKey(ws)}.json`), text = await fs.readFile(journal, "utf8");
    const poolBefore = await fingerprint(poolPaths(dataDir).git);
    await fs.unlink(journal); await expect(gc()).rejects.toThrow(/Unregistered/u);
    await fs.writeFile(journal, "{"); await expect(gc()).rejects.toThrow();
    await fs.writeFile(journal, text);
    const state = path.join(dataDir, "shadows", shadowKey(ws), "state.json"), stateText = await fs.readFile(state, "utf8");
    await fs.unlink(state); await expect(gc()).rejects.toThrow(); await fs.writeFile(state, stateText);
    expect(await fingerprint(poolPaths(dataDir).git)).toBe(poolBefore);
    await gc(); expect(git(ws, "fsck", "--full", "--no-dangling")).toBe("");
  });

  it("fails before snapshot/restore writes when the pool is unavailable or maintenance ownership is uncertain", async () => {
    const ws = await tempDir("ws"); await write(ws, "a", "original"); const saved = await snap(ws); await migrate();
    await write(ws, "a", "edited"); const before = await snapshotTree(ws);
    const paths = poolPaths(dataDir), moved = `${paths.root}-offline`;
    await fs.rename(paths.root, moved);
    try {
      await expect(snap(ws)).rejects.toThrow(/unavailable/u); await expect(restore(ws, saved)).rejects.toThrow(/unavailable/u);
      await expect(migrate()).rejects.toThrow(/unavailable/u); await expect(gc()).rejects.toThrow(/unavailable/u);
      expect(await exists(paths.root)).toBe(false);
    }
    finally { await fs.rename(moved, paths.root); }
    await fs.writeFile(paths.lock, JSON.stringify({ pid: 123, operation: "uncertain orphan" }));
    try { await expect(snap(ws)).rejects.toThrow(/locked/u); await expect(gc()).rejects.toThrow(/locked/u); }
    finally { await fs.unlink(paths.lock); }
    expect(await snapshotTree(ws)).toEqual(before);
    await restore(ws, saved);
  });

  it.skipIf(process.platform === "win32")("rejects an index or object-info symlink without writing into user Git", async () => {
    const ws = await tempDir("ws"); await initRepo(ws, { a: "kept" }); await snap(ws);
    const root = path.join(dataDir, "shadows", shadowKey(ws), "git");
    const index = path.join(root, "index"); await fs.rename(index, `${index}.saved`);
    await fs.symlink(path.join(ws, ".git", "index"), index);
    const before = await fingerprint(path.join(ws, ".git"));
    await expect(migrate()).rejects.toThrow(/Unsafe participant index/u);
    expect(await fingerprint(path.join(ws, ".git"))).toBe(before);
    await fs.unlink(index); await fs.rename(`${index}.saved`, index);
    const info = path.join(root, "objects", "info"); await fs.rename(info, `${info}.saved`);
    await fs.symlink(path.join(ws, ".git", "objects", "info"), info);
    await expect(migrate()).rejects.toThrow(/Unsafe Rewind repository directory/u);
    expect(await fingerprint(path.join(ws, ".git"))).toBe(before);
    await fs.unlink(info); await fs.rename(`${info}.saved`, info);
    await migrate(); await gc();
  });

  it("pins persistent index/cache roots after checkpoint refs expire and avoids re-copying borrowed packs", async () => {
    const ws = await tempDir("ws"); await write(ws, "a", randomBytes(256 * 1024)); const saved = await snap(ws); await migrate();
    await harness.experimental_call("deleteRefs", { workspace: ws, checkpointIds: [saved.checkpointId] });
    await gc();
    expect(poolGit("show-ref")).toContain(`${shadowKey(ws)}/lastCommit`);
    expect(poolGit("show-ref")).toContain(`${shadowKey(ws)}/index`);
    const repeated = await snap(ws); expect(repeated.commit).toBe(saved.commit);
    await harness.experimental_call("compact", { workspace: ws, dryRun: false, deep: true });
    const local = await directorySize(path.join(dataDir, "shadows", shadowKey(ws), "git", "objects"));
    expect(local!).toBeLessThan(32 * 1024);
    expect(git(ws, "fsck", "--full", "--no-dangling")).toBe("");
  });

  it("pins imports and live comparisons during GC", async () => {
    const a = await tempDir("a"), b = await tempDir("b");
    await write(a, "a", "before-import"); await snap(a);
    await write(b, "a", "destination"); const old = await snap(b); await migrate();
    await write(a, "a", "source"); const source = await snap(a);
    await restore(b, source, a);
    await write(b, "a", "comparison-only");
    const input = { workspace: b, from: { kind: "checkpoint" as const, checkpointId: old.checkpointId, commit: old.commit }, to: { kind: "workspace" as const }, paths: null, patch: true, maxFiles: 20, maxPatchBytesPerFile: 10000, maxPatchBytesTotal: 10000, limits };
    const comparison = await harness.experimental_call("diff", input);
    expect(comparison.status).toBe("ok"); if (comparison.status !== "ok") throw new Error("no comparison");
    await harness.experimental_call("removeShadow", { key: shadowKey(a) }); await gc();
    expect(poolGit("show-ref")).toContain("refs/rewind-import/");
    expect(poolGit("show-ref")).toContain("refs/rewind-comparison/");
    const paged = await harness.experimental_call("diff", { ...input, comparison: comparison.comparison, paths: ["a"] });
    expect(paged.status).toBe("ok"); if (paged.status === "ok") expect(paged.files[0]?.patch).toContain("comparison-only");
    expect(git(b, "show", `${source.commit}:a`)).toBe("source");
  });

  it("retains retired roots for two hours and actually collects old unreachable pool objects", async () => {
    const ws = await tempDir("ws"); await write(ws, "a", "kept"); await snap(ws);
    const orphan = git(ws, "hash-object", "-w", "--stdin"); git(ws, "update-ref", "refs/test-pin", orphan);
    await migrate(); git(ws, "update-ref", "-d", "refs/test-pin");
    const start = Date.now(); const pool = new ObjectPool(dataDir, undefined, () => start);
    await pool.gc(false);
    expect(poolGit("for-each-ref", "refs/rewind-pool/retired/")).toContain(orphan);
    await new ObjectPool(dataDir, undefined, () => start + 2 * 60 * 60 * 1000 - 1).gc(false);
    expect(poolGit("for-each-ref", "refs/rewind-pool/retired/")).toContain(orphan);
    await new ObjectPool(dataDir, undefined, () => start + 2 * 60 * 60 * 1000 + 1).gc(false);
    expect(poolGit("for-each-ref", "refs/rewind-pool/retired/")).toBe("");
    const junk = execFileSync("git", [`--git-dir=${poolPaths(dataDir).git}`, "hash-object", "-w", "--stdin"], { input: "old unreachable garbage", encoding: "utf8" }).trim();
    const file = path.join(poolPaths(dataDir).objects, junk.slice(0, 2), junk.slice(2));
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000); await fs.utimes(file, old, old);
    await gc(); expect(await exists(file)).toBe(false);
    expect(() => poolGit("cat-file", "-e", junk)).toThrow();
  });

  it("drains an active snapshot before GC and keeps ordinary readers concurrent", async () => {
    const ws = await tempDir("ws"); await write(ws, "a", "original"); await snap(ws); await migrate();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }), barrier = new Promise<void>(r => { release = r; });
    const original = Shadow.prototype.snapshot;
    const spy = vi.spyOn(Shadow.prototype, "snapshot").mockImplementation(async function (this: Shadow, ...args) { enter(); await barrier; return original.apply(this, args); });
    const saving = snap(ws); await entered;
    const collecting = gc(); await new Promise<void>(r => setImmediate(r));
    expect(await exists(poolPaths(dataDir).lock)).toBe(false);
    release(); await saving; await collecting; spy.mockRestore();
    let readEntered = false;
    await withPoolRead(dataDir, async () => { await withPoolRead(dataDir, async () => { readEntered = true; }); });
    expect(readEntered).toBe(true);
  });

  it("cancels a queued reader without releasing an active writer", async () => {
    let entered!: () => void, release!: () => void;
    const active = new Promise<void>(r => { entered = r; }), barrier = new Promise<void>(r => { release = r; });
    const writer = withPoolWrite(dataDir, "test", async () => { entered(); await barrier; }); await active;
    const controller = new AbortController(); const reader = withPoolRead(dataDir, async () => "impossible", controller.signal);
    const rejected = expect(reader).rejects.toThrow(); controller.abort(); await rejected;
    expect(await exists(poolPaths(dataDir).lock)).toBe(true);
    release(); await writer; expect(await withPoolRead(dataDir, async () => "available")).toBe("available");
  });
});
