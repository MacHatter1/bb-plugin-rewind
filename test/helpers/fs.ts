// Filesystem helpers for integration tests: temp workspaces, snapshots of a
// directory tree for byte-for-byte comparison, and a fingerprint of a .git
// directory to prove Rewind never writes into it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cleanups: string[] = [];

/**
 * The real temp directory: git reports real paths, and on Windows os.tmpdir()
 * can use 8.3 short names (C:\Users\RUNNER~1\…) that would not match them.
 */
const TEMP_ROOT = realpathSync.native(os.tmpdir());

export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(TEMP_ROOT, `rewind-${prefix}-`));
  cleanups.push(dir);
  return dir;
}

export async function removeTempDirs(): Promise<void> {
  while (cleanups.length > 0) {
    const dir = cleanups.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
}

export async function write(root: string, relative: string, content: string | Buffer, mode?: number): Promise<void> {
  const full = path.join(root, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, mode === undefined ? {} : { mode });
}

export async function link(root: string, relative: string, target: string): Promise<void> {
  const full = path.join(root, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await symlink(target, full);
}

export type TreeEntry =
  | { type: "file"; sha: string; executable: boolean; size: number }
  | { type: "symlink"; target: string };

/**
 * Every file and symlink under `root` (not following symlinks), keyed by
 * relative path. `.git` is skipped at the root only, like git does.
 */
export async function snapshotTree(root: string, options: { skip?: (relative: string) => boolean } = {}): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (relative === ".git") continue;
      if (options.skip?.(relative)) continue;
      const full = path.join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        out.set(relative, { type: "symlink", target: await readlink(full) });
      } else if (info.isDirectory()) {
        await walk(full, relative);
      } else if (info.isFile()) {
        const content = await readFile(full);
        out.set(relative, {
          type: "file",
          sha: createHash("sha256").update(content).digest("hex"),
          executable: (info.mode & 0o111) !== 0,
          size: info.size,
        });
      }
    }
  };
  await walk(root, "");
  return out;
}

export function treeToObject(tree: Map<string, TreeEntry>): Record<string, TreeEntry> {
  return Object.fromEntries([...tree.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Names, sizes, mtimes and contents of every file under a .git directory. */
export async function fingerprint(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (current: string) => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const info = await lstat(full);
      hash.update(`${path.relative(dir, full)}|${info.size}|${info.mtimeMs}|${info.mode}\n`);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) hash.update(await readFile(full));
    }
  };
  await walk(dir);
  return hash.digest("hex");
}

/**
 * Synchronous git in tests blocks the worker, so vitest's own timeout cannot
 * interrupt it; a stuck git must fail the test instead of hanging the run.
 */
export const GIT_TIMEOUT_MS = 20_000;

/** Run git in the user's test repository (not the shadow). */
export function userGit(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, timeout: GIT_TIMEOUT_MS },
  );
}

export async function initRepo(root: string, files: Record<string, string>): Promise<void> {
  userGit(root, "init", "-q", "-b", "main");
  for (const [relative, content] of Object.entries(files)) await write(root, relative, content);
  userGit(root, "add", "-A");
  userGit(root, "commit", "-q", "-m", "initial");
}

export async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
