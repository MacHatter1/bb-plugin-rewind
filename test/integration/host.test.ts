// Integration tests for the host entry: real git, real temp directories, the
// handlers called through the SDK's host harness (so the contract schemas and
// JSON transport apply exactly as in the daemon).
import { execFileSync } from "node:child_process";
import { chmod, lstat, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
