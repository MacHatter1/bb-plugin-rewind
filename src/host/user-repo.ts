// Read-only questions about the user's own repository. None of these write:
// they run with GIT_OPTIONAL_LOCKS=0 so git never refreshes the user's index,
// and none of them touch refs, HEAD, the stash, or the object store.
import { lstat, readFile } from "node:fs/promises";
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
  topLevel: string | null;
  commonDir: string | null;
  /** Workspace path relative to the top level, `""` at the root. */
  prefix: string;
  /** The effective core.excludesFile, or the XDG default. */
  excludesFile: string | null;
}

const NOT_GIT: RepoLayout = { isGit: false, topLevel: null, commonDir: null, prefix: "", excludesFile: null };

const layoutCache = new Map<string, { at: number; value: RepoLayout }>();
const forcedCache = new Map<string, { at: number; value: string[] }>();

function userGit(workspace: string, args: string[], options: { input?: Buffer; okExitCodes?: number[]; timeoutMs?: number } = {}) {
  return runGit(["-c", "core.fsmonitor=false", ...args], {
    cwd: workspace,
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

export async function probeLayout(workspace: string, now = Date.now()): Promise<RepoLayout> {
  const cached = layoutCache.get(workspace);
  if (cached !== undefined && now - cached.at < LAYOUT_TTL_MS) return cached.value;
  let value: RepoLayout;
  try {
    // --git-common-dir prints a path relative to the working directory when
    // relative; resolving it here avoids needing --path-format (git 2.31+).
    const { stdout } = await userGit(workspace, ["rev-parse", "--show-toplevel", "--git-common-dir", "--show-prefix"]);
    const [topLevel = "", commonDir = "", prefix = ""] = stdout.toString("utf8").split("\n");
    if (topLevel.length === 0) {
      value = NOT_GIT;
    } else {
      let excludesFile: string | null = null;
      try {
        const configured = await userGit(workspace, ["config", "--path", "--get", "core.excludesFile"], { okExitCodes: [0, 1] });
        const text = configured.stdout.toString("utf8").trim();
        excludesFile = text.length > 0 ? text : defaultExcludesFile();
      } catch {
        excludesFile = defaultExcludesFile();
      }
      value = {
        isGit: true,
        topLevel,
        commonDir: commonDir.length > 0 ? path.resolve(workspace, commonDir) : null,
        prefix: prefix.replace(/\/+$/u, ""),
        excludesFile,
      };
    }
  } catch (error) {
    // "not a git repository" (128) is the common case; anything else also
    // means we cannot use the user's repository, which is safe to assume.
    if (!(error instanceof GitError)) throw error;
    // Outside a repository git still reads the user's global config.
    let excludesFile = defaultExcludesFile();
    try {
      const configured = await userGit(workspace, ["config", "--path", "--get", "core.excludesFile"], { okExitCodes: [0, 1] });
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

async function readSmallFile(file: string): Promise<string | null> {
  try {
    const buffer = await readFile(file);
    if (buffer.length > MAX_IGNORE_FILE_BYTES) return buffer.subarray(0, MAX_IGNORE_FILE_BYTES).toString("utf8");
    return buffer.toString("utf8");
  } catch {
    return null;
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
export async function userIgnoreSources(workspace: string, layout: RepoLayout): Promise<UserIgnoreSource[]> {
  const sources: UserIgnoreSource[] = [];
  if (layout.excludesFile !== null) {
    const content = await readSmallFile(layout.excludesFile);
    if (content !== null) sources.push({ label: "core.excludesFile", content, prefix: layout.prefix });
  }
  if (!layout.isGit || layout.topLevel === null) return sources;
  if (layout.commonDir !== null) {
    const content = await readSmallFile(path.join(layout.commonDir, "info", "exclude"));
    if (content !== null) sources.push({ label: "the repository's info/exclude", content, prefix: layout.prefix });
  }
  if (layout.prefix.length > 0) {
    const parts = layout.prefix.split("/");
    for (let depth = 0; depth < parts.length; depth += 1) {
      const directory = path.join(layout.topLevel, ...parts.slice(0, depth));
      const content = await readSmallFile(path.join(directory, ".gitignore"));
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
export async function trackedButIgnored(workspace: string, layout: RepoLayout, now = Date.now()): Promise<string[]> {
  if (!layout.isGit) return [];
  const cached = forcedCache.get(workspace);
  if (cached !== undefined && now - cached.at < FORCED_TTL_MS) return cached.value;
  let value: string[] = [];
  try {
    const { stdout } = await userGit(workspace, ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]);
    value = splitNul(stdout).map(toInternal);
  } catch {
    value = [];
  }
  forcedCache.set(workspace, { at: now, value });
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
    const parts = candidate.split("/");
    let beyondLink = false;
    for (let depth = 1; depth < parts.length && !beyondLink; depth += 1) {
      beyondLink = await isSymlink(parts.slice(0, depth).join("/"));
    }
    if (beyondLink) unknown.add(candidate);
    else checkable.push(candidate);
  }

  const check = async (batch: readonly string[]) => {
    const { stdout } = await userGit(workspace, ["check-ignore", "-z", "--stdin"], {
      input: nulInput(batch),
      okExitCodes: [0, 1],
      timeoutMs: 60_000,
    });
    return splitNul(stdout).map(toInternal);
  };
  if (checkable.length === 0) return { ignored, unknown };
  try {
    for (const candidate of await check(checkable)) ignored.add(candidate);
    return { ignored, unknown };
  } catch {
    // Some other path git refuses (e.g. inside a submodule): ask one at a time.
  }
  for (const candidate of checkable) {
    try {
      if ((await check([candidate])).length > 0) ignored.add(candidate);
    } catch {
      unknown.add(candidate);
    }
  }
  return { ignored, unknown };
}

/** For tests: resolve an internal path to a Buffer for fs calls. */
export const pathBuffer = internalToBuffer;
