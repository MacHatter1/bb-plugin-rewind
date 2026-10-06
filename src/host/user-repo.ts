// Read-only questions about the user's own repository. None of these write:
// they run with GIT_OPTIONAL_LOCKS=0 so git never refreshes the user's index,
// and none of them touch refs, HEAD, the stash, or the object store.
import { lstat, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HeadInfo } from "../host-contract";
import { GitError, internalToBuffer, nulInput, runGit, splitNul, toInternal } from "./git";

const READ_ONLY_ENV = { GIT_OPTIONAL_LOCKS: "0" } as const;
const LAYOUT_TTL_MS = 30_000;
const FORCED_TTL_MS = 60_000;
const MAX_IGNORE_FILE_BYTES = 1024 * 1024;

export interface RepoLayout {
  isGit: boolean;
  indexFile?: string;
  topLevel: string | null;
  commonDir: string | null;
  /** Workspace path relative to the top level, `""` at the root. */
  prefix: string;
  /** The effective core.excludesFile, or the XDG default. */
  excludesFile: string | null;
}

const NOT_GIT: RepoLayout = { isGit: false, topLevel: null, commonDir: null, prefix: "", excludesFile: null };

const layoutCache = new Map<string, { at: number; value: RepoLayout }>();
const forcedCache = new Map<string, { at: number; indexStamp: string; value: string[] }>();

function userGit(workspace: string, args: string[], options: { input?: Buffer; okExitCodes?: number[]; timeoutMs?: number; signal?: AbortSignal } = {}) {
  return runGit(["-c", "core.fsmonitor=false", ...args], {
    cwd: workspace,
    signal: options.signal,
    env: READ_ONLY_ENV,
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.okExitCodes === undefined ? {} : { okExitCodes: options.okExitCodes }),
  });
}

function defaultExcludesFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "git", "ignore");
}

export function clearUserRepoCaches(): void {
  layoutCache.clear();
  forcedCache.clear();
}

export async function probeLayout(workspace: string, now = Date.now(), signal?: AbortSignal): Promise<RepoLayout> {
  const cached = layoutCache.get(workspace);
  if (cached !== undefined && now - cached.at < LAYOUT_TTL_MS) return cached.value;
  let value: RepoLayout;
  try {
    // --git-common-dir prints a path relative to the working directory when
    // relative; resolving it here avoids needing --path-format (git 2.31+).
    const { stdout } = await userGit(workspace, ["rev-parse", "--show-toplevel", "--git-common-dir", "--show-prefix", "--git-path", "index"], { signal });
    const [topLevel = "", commonDir = "", prefix = "", indexFile = ""] = stdout.toString("utf8").split("\n");
    if (topLevel.length === 0) {
      value = NOT_GIT;
    } else {
      let excludesFile: string | null = null;
      try {
        const configured = await userGit(workspace, ["config", "--path", "--get", "core.excludesFile"], { okExitCodes: [0, 1], signal });
        const text = configured.stdout.toString("utf8").trim();
        excludesFile = text.length > 0 ? text : defaultExcludesFile();
      } catch {
        excludesFile = defaultExcludesFile();
      }
      value = {
        isGit: true,
        indexFile: path.resolve(workspace, indexFile),
        topLevel,
        commonDir: commonDir.length > 0 ? path.resolve(workspace, commonDir) : null,
        prefix: prefix.replace(/\/+$/u, ""),
        excludesFile,
      };
    }
  } catch (error) {
    // "not a git repository" (128) is the common case; anything else also
    // means we cannot use the user's repository, which is safe to assume.
    signal?.throwIfAborted();
    if (!(error instanceof GitError)) throw error;
    // Outside a repository git still reads the user's global config.
    let excludesFile = defaultExcludesFile();
    try {
      const configured = await userGit(workspace, ["config", "--path", "--get", "core.excludesFile"], { okExitCodes: [0, 1], signal });
      const text = configured.stdout.toString("utf8").trim();
      if (text.length > 0) excludesFile = text;
    } catch {
      // Keep the default.
    }
    value = { ...NOT_GIT, excludesFile };
  }
  layoutCache.set(workspace, { at: now, value });
  return value;
}

export async function readHead(workspace: string): Promise<HeadInfo> {
  const [sha, branch] = await Promise.all([
    userGit(workspace, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], { okExitCodes: [0, 1, 128] }).then(
      (result) => result.stdout.toString("utf8").trim(),
      () => "",
    ),
    userGit(workspace, ["symbolic-ref", "-q", "--short", "HEAD"], { okExitCodes: [0, 1, 128] }).then(
      (result) => result.stdout.toString("utf8").trim(),
      () => "",
    ),
  ]);
  return {
    sha: /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(sha) ? sha : null,
    branch: branch.length > 0 ? branch.slice(0, 1024) : null,
  };
}

async function readSmallFile(file: string, signal?: AbortSignal): Promise<string | null> {
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await open(file, "r");
    if ((await handle.stat()).size > MAX_IGNORE_FILE_BYTES) throw new Error(`ignore source ${file} exceeds ${MAX_IGNORE_FILE_BYTES} bytes; capture/restore is unsafe`);
    // Read at most cap + one sentinel byte, including a file that grows after stat.
    const buffer = Buffer.alloc(MAX_IGNORE_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > MAX_IGNORE_FILE_BYTES) throw new Error(`ignore source ${file} exceeds ${MAX_IGNORE_FILE_BYTES} bytes; capture/restore is unsafe`);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch (error) {
    if (handle === undefined && ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export interface UserIgnoreSource {
  label: string;
  content: string;
  prefix: string;
}

/**
 * Ignore rules the user's git applies to the workspace that the shadow would
 * not read by itself: info/exclude, the excludes file, and .gitignore files
 * in directories above a subdirectory workspace.
 */
export async function userIgnoreSources(workspace: string, layout: RepoLayout, signal?: AbortSignal): Promise<UserIgnoreSource[]> {
  const sources: UserIgnoreSource[] = [];
  if (layout.excludesFile !== null) {
    const content = await readSmallFile(layout.excludesFile, signal);
    if (content !== null) sources.push({ label: "core.excludesFile", content, prefix: layout.prefix });
  }
  if (!layout.isGit || layout.topLevel === null) return sources;
  if (layout.commonDir !== null) {
    const content = await readSmallFile(path.join(layout.commonDir, "info", "exclude"), signal);
    if (content !== null) sources.push({ label: "the repository's info/exclude", content, prefix: layout.prefix });
  }
  if (layout.prefix.length > 0) {
    const parts = layout.prefix.split("/");
    for (let depth = 0; depth < parts.length; depth += 1) {
      const directory = path.join(layout.topLevel, ...parts.slice(0, depth));
      const content = await readSmallFile(path.join(directory, ".gitignore"), signal);
      if (content === null) continue;
      sources.push({
        label: `${path.join(...(depth === 0 ? ["."] : parts.slice(0, depth)), ".gitignore")} above the workspace`,
        content,
        prefix: parts.slice(depth).join("/"),
      });
    }
  }
  return sources;
}

/**
 * Files the user's repository tracks although its ignore rules match them
 * (force-added). The shadow must capture them like any tracked file.
 */
export async function trackedButIgnored(workspace: string, layout: RepoLayout, now = Date.now(), signal?: AbortSignal): Promise<string[]> {
  if (!layout.isGit) return [];
  const info = layout.indexFile === undefined ? null : await stat(layout.indexFile, { bigint: true }).catch(() => null);
  const indexStamp = info === null ? "missing" : `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  const cached = forcedCache.get(workspace);
  if (cached !== undefined && cached.indexStamp === indexStamp && now - cached.at < FORCED_TTL_MS) return cached.value;
  let value: string[] = [];
  try {
    const { stdout } = await userGit(workspace, ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"], { signal });
    value = splitNul(stdout).map(toInternal);
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
  forcedCache.set(workspace, { at: now, indexStamp, value });
  return value;
}

/**
 * Which of `paths` the user's git ignores. Tracked files are never reported
 * (git consults the user's index). Paths git refuses to check — beyond a
 * symlink, inside a submodule — come back as `unknown` rather than guessed.
 */
export async function userIgnoredPaths(
  workspace: string,
  layout: RepoLayout,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<{ ignored: Set<string>; unknown: Set<string> }> {
  const ignored = new Set<string>();
  const unknown = new Set<string>();
  if (!layout.isGit || paths.length === 0) return { ignored, unknown };

  // git rejects the whole batch for one path beyond a symlink; find those
  // first (cheaply, with a memoized lstat of each ancestor).
  const linkCache = new Map<string, boolean>();
  const isSymlink = async (relative: string) => {
    if (!linkCache.has(relative)) {
      try {
        linkCache.set(relative, (await lstat(Buffer.concat([Buffer.from(workspace, "utf8"), Buffer.from("/"), internalToBuffer(relative)]))).isSymbolicLink());
      } catch {
        linkCache.set(relative, false);
      }
    }
    return linkCache.get(relative)!;
  };
  const checkable: string[] = [];
  for (const candidate of paths) {
    signal?.throwIfAborted();
    const parts = candidate.split("/");
    let beyondLink = false;
    for (let depth = 1; depth < parts.length && !beyondLink; depth += 1) {
      beyondLink = await isSymlink(parts.slice(0, depth).join("/"));
    }
    if (beyondLink) unknown.add(candidate);
    else checkable.push(candidate);
  }

  const deadline = Date.now() + 30_000;
  let operations = 0;
  const check = async (batch: readonly string[]) => {
    signal?.throwIfAborted();
    operations++;
    const remaining = deadline - Date.now();
    if (operations > 64 || remaining <= 0) throw new Error("Ignore-check budget exhausted");
    const { stdout } = await userGit(workspace, ["check-ignore", "-z", "--stdin"], {
      input: nulInput(batch),
      okExitCodes: [0, 1],
      timeoutMs: Math.max(1, deadline - Date.now()),
      signal,
    });
    return splitNul(stdout).map(toInternal);
  };
  if (checkable.length === 0) return { ignored, unknown };
  const isolate = async (batch: readonly string[]): Promise<void> => {
    signal?.throwIfAborted();
    if (operations >= 64 || Date.now() >= deadline) {
      for (const candidate of batch) unknown.add(candidate);
      return;
    }
    try {
      for (const candidate of await check(batch)) ignored.add(candidate);
    } catch {
      signal?.throwIfAborted();
      if (batch.length === 1) { unknown.add(batch[0]!); return; }
      const middle = Math.floor(batch.length / 2);
      await isolate(batch.slice(0, middle));
      await isolate(batch.slice(middle));
    }
  };
  await isolate(checkable);
  return { ignored, unknown };
}

/** Memoized ancestor boundary probes; never follow a nested repository or gitfile. */
export function nestedRepositoryProbe(workspace: string, signal?: AbortSignal): (candidate: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return async (candidate) => {
    signal?.throwIfAborted();
    for (let slash = candidate.indexOf("/"); slash !== -1; slash = candidate.indexOf("/", slash + 1)) {
      signal?.throwIfAborted();
      const parent = candidate.slice(0, slash);
      let found = cache.get(parent);
      if (found === undefined) {
        found = lstat(Buffer.concat([Buffer.from(workspace + "/"), internalToBuffer(parent), Buffer.from("/.git")])).then(
          info => info.isDirectory() || info.isFile() || info.isSymbolicLink(),
          error => { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false; throw error; },
        );
        cache.set(parent, found);
      }
      const isNested = await found;
      signal?.throwIfAborted();
      if (isNested) return true;
    }
    return false;
  };
}

/** For tests: resolve an internal path to a Buffer for fs calls. */
export const pathBuffer = internalToBuffer;
