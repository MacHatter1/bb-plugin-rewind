// One shadow git repository per workspace, stored in the plugin's host data
// directory and driven with --git-dir=<shadow> --work-tree=<workspace>.
//
// The shadow owns its index (a persistent stat cache, so later snapshots only
// rehash changed files), its object store (self-contained: nothing borrows
// from the user's repository), and one ref per checkpoint
// (refs/rewind/<checkpointId>). Nothing here writes into the workspace except
// `restore`, and nothing ever writes into the user's .git.
import { createHash } from "node:crypto";
import { access, constants as fsConstants, lstat, mkdir, open, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BB_CHAT_DIR,
  EMPTY_TREE,
  MAX_LISTED_SKIPPED,
  MAX_STORED_CHANGES,
  UNSUPPORTED_RECHECK_MS,
} from "../constants";
import type {
  ChangeStats,
  DiffFile,
  DiffResult,
  FileChange,
  HeadInfo,
  RestorePlan,
  RestoreResult,
  Revision,
  SkippedFile,
  SnapshotLimits,
  SnapshotOk,
  SnapshotResult,
  Verification,
} from "../host-contract";
import { anchoredPattern, composeExcludeFile } from "./ignore";
import {
  GitError,
  GitRecordLimitError,
  internalToBuffer,
  nulInput,
  runGit,
  splitNul,
  toDisplay,
  toInternal,
  fromDisplay,
  type GitRunOptions,
  type GitRunResult,
} from "./git";
import { indexEntryCount, parseDiffTree, parseStatusV2, splitPatch, type TreeChange } from "./parse";
import { actionFor, planRestore, type EntryKind } from "./plan";
import {
  probeLayout,
  readHead,
  trackedButIgnored,
  userIgnoredPaths,
  userIgnoreSources,
  type RepoLayout,
} from "./user-repo";

const STATE_VERSION = 1;
const SHADOWS_DIR = "shadows";
const NULL_SHA = "0000000000000000000000000000000000000000";
const STAT_CONCURRENCY = 32;
const MAX_UPDATE_RETRIES = 8;
const VERIFY_LIST_LIMIT = 50;
const MAX_SKIP_PATHS = 500;

export interface ShadowState {
  version: number;
  workspace: string;
  createdAt: number;
  lastUsedAt: number;
  lastSnapshotAt: number | null;
  lastTree: string | null;
  lastCommit: string | null;
  caseInsensitive: boolean;
  /** This process can create symlinks (Windows needs a privilege or Developer Mode). */
  symlinks: boolean;
  unsupported: { reason: string; until: number; fileCount: number | null; totalBytes: number | null } | null;
  /**
   * bb thread storage directories inside the workspace, relative and
   * "/"-separated. Remembered, so a call made for one thread still leaves
   * another thread's storage alone.
   */
  skipPaths: string[];
}

/** Waits before retrying a restore that hit locked files. */
const APPLY_RETRY_DELAYS_MS = [250, 750, 1_500];
/** git's errors for files it could not replace: locked (Windows) or not writable. */
const LOCKED_FILE = /unable to (?:unlink|create|write|open)|Permission denied|Operation not permitted|Device or resource busy|being used by another process|Invalid argument/u;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether this process may create symbolic links. Only Windows restricts it;
 * the probe runs in Rewind's own directory, never in the workspace.
 */
async function probeSymlinks(directory: string): Promise<boolean> {
  if (process.platform !== "win32") return true;
  const probe = path.join(directory, `symlink-probe-${process.pid}`);
  try {
    await symlink("symlink-probe-target", probe);
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function shadowKey(workspace: string): string {
  return createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 32);
}

export function shadowsRoot(dataDir: string): string {
  return path.join(dataDir, SHADOWS_DIR);
}

/** Decode the creation time embedded in a Rewind id (`ck_<9 base36 digits>…`). */
export function idTime(id: string): number | null {
  const match = /^[a-z]{2}_([0-9a-z]{9})/u.exec(id);
  if (match === null) return null;
  const value = Number.parseInt(match[1]!, 36);
  return Number.isFinite(value) ? value : null;
}

async function pathExists(target: string | Buffer): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

function swapCase(value: string): string {
  let out = "";
  for (const char of value) {
    const lower = char.toLowerCase();
    out += char === lower ? char.toUpperCase() : lower;
  }
  return out;
}

/** Case sensitivity of the filesystem holding `directory`, probed without writing. */
async function probeCaseInsensitive(directory: string): Promise<boolean> {
  let candidate = path.resolve(directory);
  for (;;) {
    const base = path.basename(candidate);
    if (/[A-Za-z]/u.test(base)) {
      const toggled = path.join(path.dirname(candidate), swapCase(base));
      try {
        const [original, flipped] = await Promise.all([stat(candidate), stat(toggled)]);
        return original.ino === flipped.ino && original.dev === flipped.dev;
      } catch {
        return false;
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return process.platform === "darwin" || process.platform === "win32";
    candidate = parent;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function statsOf(changes: readonly TreeChange[]): ChangeStats {
  let insertions = 0;
  let deletions = 0;
  for (const change of changes) {
    insertions += change.additions ?? 0;
    deletions += change.deletions ?? 0;
  }
  return { files: changes.length, insertions, deletions };
}

function toFileChange(change: TreeChange): FileChange {
  return {
    path: toDisplay(change.path),
    status: change.status,
    oldMode: change.oldMode,
    newMode: change.newMode,
    binary: change.binary,
    additions: change.additions,
    deletions: change.deletions,
  };
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Number((bytes / 1024 ** 3).toFixed(1))} GB`;
  if (bytes >= 1024 ** 2) return `${Number((bytes / 1024 ** 2).toFixed(1))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function displaySkipped(list: readonly SkippedFile[]): SkippedFile[] {
  return list.slice(0, MAX_LISTED_SKIPPED).map((entry) => ({ ...entry, path: toDisplay(entry.path) }));
}

/** Paths in update-index/add errors ("open("x"): Permission denied", "Unable to process path x"). */
export function parseUnprocessablePath(stderr: string): string | null {
  const patterns = [
    /error: open\("(.+)"\): /u,
    /fatal: Unable to process path (.+)$/mu,
    /error: unable to index file '?([^'\n]+)'?$/mu,
    /error: (.+): is a directory - add files inside instead/u,
    /error: (.+): cannot add to the index/u,
    /error: (.+): does not exist and --remove not passed/u,
    /error: (.+): failed to insert into database/u,
    /error: short read while indexing (.+)$/mu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(stderr);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return null;
}

type CaptureResult =
  | { status: "ok"; tree: string; skipped: SkippedFile[]; fileCount: number; layout: RepoLayout }
  | { status: "unsupported"; reason: string; fileCount: number | null; totalBytes: number | null };

interface CaptureOptions {
  limits: SnapshotLimits;
  signal?: AbortSignal;
}

export class Shadow {
  readonly key: string;
  readonly root: string;
  readonly gitDir: string;
  private readonly stateFile: string;
  private readonly emptyExcludes: string;
  private state: ShadowState | null = null;

  /** Workspace-relative directories never captured, diffed, or restored. */
  private readonly skipDirs: string[] = [BB_CHAT_DIR];

  constructor(
    readonly dataDir: string,
    readonly workspace: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = shadowKey(workspace);
    this.root = path.join(shadowsRoot(dataDir), this.key);
    this.gitDir = path.join(this.root, "git");
    this.stateFile = path.join(this.root, "state.json");
    this.emptyExcludes = path.join(this.root, "no-excludes");
  }

  static fromKey(dataDir: string, key: string): { root: string } {
    return { root: path.join(shadowsRoot(dataDir), key) };
  }

  // ---------------------------------------------------------------- git

  private configArgs(): string[] {
    const state = this.state;
    const pairs = [
      "core.bare=false",
      "core.logAllRefUpdates=false",
      "core.autocrlf=false",
      "core.safecrlf=false",
      "core.fsmonitor=false",
      "core.untrackedCache=false",
      "core.splitIndex=false",
      "core.sparseCheckout=false",
      "core.quotePath=false",
      `core.excludesFile=${this.emptyExcludes}`,
      `core.ignoreCase=${state?.caseInsensitive === true ? "true" : "false"}`,
      // Windows has no executable bit; symlinks only with the privilege.
      `core.fileMode=${process.platform === "win32" ? "false" : "true"}`,
      `core.symlinks=${(state?.symlinks ?? process.platform !== "win32") ? "true" : "false"}`,
      // Paths past 260 characters on Windows; ignored elsewhere.
      "core.longpaths=true",
      "gc.auto=0",
      "maintenance.auto=false",
      "submodule.recurse=false",
      "commit.gpgSign=false",
      "diff.noprefix=false",
      "diff.mnemonicPrefix=false",
      "diff.relative=false",
      "diff.renames=false",
      "diff.external=",
      "color.ui=false",
      "status.renames=false",
      "advice.addEmbeddedRepo=false",
    ];
    if (process.platform === "darwin") pairs.push("core.precomposeUnicode=true");
    return pairs.flatMap((pair) => ["-c", pair]);
  }

  /** git with the workspace as work tree (status, update-index, read-tree -u). */
  git(args: readonly string[], options: Partial<GitRunOptions> = {}): Promise<GitRunResult> {
    return runGit([`--git-dir=${this.gitDir}`, `--work-tree=${this.workspace}`, "--literal-pathspecs", ...this.configArgs(), ...args], {
      cwd: this.workspace,
      ...options,
    });
  }

  /** git without a work tree: object and ref plumbing. */
  bare(args: readonly string[], options: Partial<GitRunOptions> = {}): Promise<GitRunResult> {
    return runGit([`--git-dir=${this.gitDir}`, "--literal-pathspecs", ...this.configArgs(), ...args], {
      cwd: this.root,
      ...options,
    });
  }

  private async text(args: readonly string[], options: Partial<GitRunOptions> = {}): Promise<string> {
    return (await this.bare(args, options)).stdout.toString("utf8").trim();
  }

  // -------------------------------------------------------------- state

  async exists(): Promise<boolean> {
    return pathExists(path.join(this.gitDir, "HEAD"));
  }

  async workspaceExists(): Promise<boolean> {
    try {
      return (await stat(this.workspace)).isDirectory();
    } catch {
      return false;
    }
  }

  async loadState(): Promise<ShadowState | null> {
    if (this.state !== null) return this.state;
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as Partial<ShadowState>;
      if (parsed.version !== STATE_VERSION) return null;
      this.state = {
        version: STATE_VERSION,
        workspace: typeof parsed.workspace === "string" ? parsed.workspace : this.workspace,
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : this.now(),
        lastUsedAt: typeof parsed.lastUsedAt === "number" ? parsed.lastUsedAt : this.now(),
        lastSnapshotAt: typeof parsed.lastSnapshotAt === "number" ? parsed.lastSnapshotAt : null,
        lastTree: typeof parsed.lastTree === "string" ? parsed.lastTree : null,
        lastCommit: typeof parsed.lastCommit === "string" ? parsed.lastCommit : null,
        caseInsensitive: parsed.caseInsensitive === true,
        symlinks: typeof parsed.symlinks === "boolean" ? parsed.symlinks : process.platform !== "win32",
        unsupported: parsed.unsupported ?? null,
        skipPaths: Array.isArray(parsed.skipPaths) ? parsed.skipPaths.filter((entry): entry is string => typeof entry === "string") : [],
      };
      return this.state;
    } catch {
      return null;
    }
  }

  private async saveState(): Promise<void> {
    if (this.state === null) return;
    this.state.lastUsedAt = this.now();
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2));
    await rename(temp, this.stateFile);
  }

  /** Create the shadow repository if it does not exist yet. */
  async ensure(): Promise<ShadowState> {
    if ((await this.exists()) && (await this.loadState()) !== null) {
      await this.clearStaleLocks();
      await this.rememberSkipDirs(this.state!);
      return this.state!;
    }
    await mkdir(this.root, { recursive: true });
    // Pin formats so a user's init.defaultObjectFormat/defaultRefFormat or
    // template directory never shapes the shadow.
    await runGit(
      [
        "-c",
        "init.defaultObjectFormat=sha1",
        "-c",
        "init.defaultRefFormat=files",
        "init",
        "-q",
        "--bare",
        "--template=",
        this.gitDir,
      ],
      { cwd: this.root },
    );
    await mkdir(path.join(this.gitDir, "info"), { recursive: true });
    // Store bytes exactly: no line-ending conversion, no clean/smudge filters
    // (git-lfs), no $Id$ expansion, no re-encoding. info/attributes outranks
    // every .gitattributes file in the work tree.
    await writeFile(path.join(this.gitDir, "info", "attributes"), "* -text -filter -ident -working-tree-encoding\n");
    await writeFile(this.emptyExcludes, "");
    this.state = {
      version: STATE_VERSION,
      workspace: this.workspace,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      lastSnapshotAt: null,
      lastTree: null,
      lastCommit: null,
      caseInsensitive: await probeCaseInsensitive(this.workspace),
      symlinks: await probeSymlinks(this.root),
      unsupported: null,
      skipPaths: [],
    };
    await this.saveState();
    await this.rememberSkipDirs(this.state);
    return this.state;
  }

  /**
   * A git process killed hard (worker crash) can leave index.lock behind,
   * which would fail every later snapshot. Callers hold this shadow's lock, so
   * no live Rewind process owns one; only clear locks older than a minute in
   * case another worker generation is mid-command.
   */
  private async clearStaleLocks(): Promise<void> {
    for (const name of ["index.lock", "HEAD.lock", "packed-refs.lock"]) {
      const file = path.join(this.gitDir, name);
      try {
        const info = await stat(file);
        if (this.now() - info.mtimeMs > 60_000) await rm(file, { force: true });
      } catch {
        // No lock.
      }
    }
  }

  private async indexCount(): Promise<number> {
    let handle;
    try {
      handle = await open(path.join(this.gitDir, "index"), "r");
      const header = Buffer.alloc(12);
      await handle.read(header, 0, 12, 0);
      return indexEntryCount(header);
    } catch {
      return 0;
    } finally {
      await handle?.close();
    }
  }

  /** Also leave alone these directories when inside the workspace (bb thread storage). */
  skipPaths(absolute: readonly string[]): this {
    const root = path.resolve(this.workspace);
    for (const dir of absolute) {
      const relative = path.relative(root, path.resolve(dir));
      // Never the whole workspace, and nothing outside it.
      if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const internal = fromDisplay(relative.split(path.sep).join("/"));
      if (!this.skipDirs.includes(internal)) this.skipDirs.push(internal);
    }
    return this;
  }

  /** Merge the directories remembered for this workspace with those passed now; remember new ones. */
  private async rememberSkipDirs(state: ShadowState): Promise<void> {
    const known = new Set(state.skipPaths);
    const fresh = this.skipDirs.map(toDisplay).filter((dir) => dir !== BB_CHAT_DIR && !known.has(dir));
    for (const dir of state.skipPaths) {
      const internal = fromDisplay(dir);
      if (!this.skipDirs.includes(internal)) this.skipDirs.push(internal);
    }
    if (fresh.length > 0) {
      state.skipPaths = [...state.skipPaths, ...fresh].slice(-MAX_SKIP_PATHS);
      await this.saveState();
    }
  }

  private skipped(relative: string): boolean {
    return this.skipDirs.some((dir) => relative === dir || relative.startsWith(`${dir}/`));
  }

  /** Changes outside the directories Rewind leaves alone. */
  private visible<T extends { path: string }>(changes: readonly T[]): T[] {
    return changes.filter((change) => !this.skipped(change.path));
  }

  /** Rewrite info/exclude from the user's rules; true when it changed. */
  private async syncExcludes(layout: RepoLayout): Promise<boolean> {
    const sources = await userIgnoreSources(this.workspace, layout);
    const extra: string[] = [];
    for (const dir of this.skipDirs) {
      const pattern = anchoredPattern(toDisplay(dir), true);
      if (pattern !== null) extra.push(pattern);
    }
    const relative = path.relative(path.resolve(this.workspace), path.resolve(this.dataDir));
    if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      const pattern = anchoredPattern(relative.split(path.sep).join("/"), true);
      if (pattern !== null) extra.push(pattern);
    }
    const content = composeExcludeFile(sources, extra);
    const file = path.join(this.gitDir, "info", "exclude");
    const current = await readFile(file, "utf8").catch(() => null);
    if (current === content) return false;
    await writeFile(file, content);
    return true;
  }

  /** Which of `paths` are in the shadow index (argv in bounded batches). */
  private async indexedAmong(paths: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let start = 0; start < paths.length; start += 500) {
      const batch = paths.slice(start, start + 500).map(toDisplay);
      const output = (await this.git(["ls-files", "-z", "--cached", "--", ...batch])).stdout;
      for (const record of splitNul(output)) found.add(toInternal(record));
    }
    return found;
  }

  private absolute(relative: string): Buffer {
    return Buffer.concat([Buffer.from(path.resolve(this.workspace), "utf8"), Buffer.from("/"), internalToBuffer(relative)]);
  }

  private async readable(relative: string): Promise<boolean> {
    try {
      await access(this.absolute(relative), fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Exists under exactly this name (not just a case variant of it). */
  private async existsExactly(relative: string): Promise<boolean> {
    if ((await this.fileKind(relative)) === null) return false;
    if (this.state?.caseInsensitive !== true) return true;
    const slash = relative.lastIndexOf("/");
    const parent = slash === -1 ? "" : relative.slice(0, slash);
    const name = internalToBuffer(slash === -1 ? relative : relative.slice(slash + 1));
    try {
      const entries = await readdir(parent === "" ? Buffer.from(path.resolve(this.workspace), "utf8") : this.absolute(parent), { encoding: "buffer" });
      return entries.some((entry) => Buffer.compare(entry, name) === 0);
    } catch {
      return true;
    }
  }

  private async fileKind(relative: string): Promise<{ kind: EntryKind; size: number } | null> {
    try {
      const info = await lstat(this.absolute(relative));
      if (info.isSymbolicLink()) return { kind: "symlink", size: info.size };
      if (info.isFile()) return { kind: "file", size: info.size };
      if (info.isDirectory()) return { kind: "dir", size: 0 };
      return { kind: "other", size: 0 };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ capture

  /**
   * Bring the shadow index in line with the workspace and write its tree.
   * Only changed paths are re-hashed. Files over the size cap and nested
   * repositories are left out and reported as skipped.
   */
  async capture(options: CaptureOptions): Promise<CaptureResult> {
    const state = await this.ensure();
    const { limits, signal } = options;
    const layout = await probeLayout(this.workspace, this.now());
    const excludesChanged = await this.syncExcludes(layout);
    const firstCapture = state.lastTree === null;

    let statusOutput: Buffer;
    try {
      statusOutput = (
        await this.git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all"], {
          maxRecords: limits.maxFiles + 1,
          timeoutMs: firstCapture ? 5 * 60_000 : 2 * 60_000,
          ...(signal === undefined ? {} : { signal }),
        })
      ).stdout;
    } catch (error) {
      if (error instanceof GitRecordLimitError) {
        return { status: "unsupported", reason: `more than ${limits.maxFiles} files to track`, fileCount: error.records, totalBytes: null };
      }
      throw error;
    }

    const toUpdate = new Map<string, boolean>(); // path → tracked in the shadow index
    const skipped: SkippedFile[] = [];
    for (const entry of parseStatusV2(statusOutput)) {
      if (this.skipped(entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path)) continue;
      if (entry.kind === "changed") {
        if (entry.y !== ".") toUpdate.set(entry.path, true);
      } else if (entry.kind === "unmerged") {
        toUpdate.set(entry.path, true);
      } else if (entry.kind === "untracked") {
        if (entry.path.endsWith("/")) {
          skipped.push({ path: entry.path.slice(0, -1), reason: "nested-repository", sizeBytes: null });
        } else {
          toUpdate.set(entry.path, false);
        }
      }
    }

    // Files the user's repository tracks despite matching an ignore rule.
    const forced = await trackedButIgnored(this.workspace, layout, this.now());
    const forcedSet = new Set(forced);
    if (forced.length > 0) {
      const indexed = await this.indexedAmong(forced);
      for (const candidate of forced) {
        if (this.skipped(candidate)) continue;
        if (!indexed.has(candidate) && !toUpdate.has(candidate) && (await this.fileKind(candidate)) !== null) {
          toUpdate.set(candidate, false);
        }
      }
    }

    // git never untracks a file because it became ignored, but the user's
    // repository does not track it either: when the rules change, drop newly
    // ignored files from the shadow so they are neither captured nor touched.
    const rulesChanged = excludesChanged || [...toUpdate.keys()].some((candidate) => candidate === ".gitignore" || candidate.endsWith("/.gitignore"));
    const toUntrack = new Set<string>();
    if (rulesChanged && !firstCapture) {
      const ignoredTracked = splitNul((await this.git(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"])).stdout).map(toInternal);
      for (const candidate of ignoredTracked) {
        if (forcedSet.has(candidate)) continue;
        toUntrack.add(candidate);
        toUpdate.delete(candidate);
      }
    }

    const toRemove = new Set<string>();
    // Entries an earlier version captured in directories now left alone.
    const stale = await this.git(["ls-files", "-z", "--cached", "--", ...this.skipDirs.map((dir) => `${toDisplay(dir)}/`)]);
    for (const entry of splitNul(stale.stdout).map(toInternal)) {
      toRemove.add(entry);
      toUpdate.delete(entry);
    }
    let newBytes = 0;
    const candidates = [...toUpdate.entries()];
    const kinds = await mapLimit(candidates, STAT_CONCURRENCY, async ([candidate]) => {
      const info = await this.fileKind(candidate);
      return info === null ? null : { ...info, readable: info.kind !== "file" || (await this.readable(candidate)) };
    });
    candidates.forEach(([candidate, tracked], index) => {
      const info = kinds[index] ?? null;
      if (info === null) return; // deleted: update-index --remove handles it
      if (info.kind === "dir" || info.kind === "other") {
        // A captured file that became a directory (or a socket, fifo…) leaves
        // the checkpoint; the directory's own files come in as new entries.
        toUpdate.delete(candidate);
        if (tracked) toRemove.add(candidate);
        return;
      }
      if (info.kind === "file" && info.size > limits.maxFileBytes) {
        skipped.push({ path: candidate, reason: "too-large", sizeBytes: info.size });
        toUpdate.delete(candidate);
        // A captured file that grew past the cap leaves the checkpoint, so no
        // restore can overwrite its current (uncaptured) content.
        if (tracked) toRemove.add(candidate);
        return;
      }
      if (!info.readable) {
        // Same for a file that can no longer be read: the checkpoint must
        // not claim its old content.
        skipped.push({ path: candidate, reason: "unreadable", sizeBytes: info.size });
        toUpdate.delete(candidate);
        if (tracked) toRemove.add(candidate);
        return;
      }
      newBytes += info.size;
    });

    const indexCount = await this.indexCount();
    let untrackedNew = 0;
    for (const tracked of toUpdate.values()) if (!tracked) untrackedNew += 1;
    if (indexCount + untrackedNew > limits.maxFiles) {
      return { status: "unsupported", reason: `more than ${limits.maxFiles} files to track`, fileCount: indexCount + untrackedNew, totalBytes: null };
    }
    // Checked on every capture, not only the first: a later download of many
    // mid-sized files must not be hashed wholesale either.
    if (newBytes > limits.maxTotalBytes) {
      return {
        status: "unsupported",
        reason: `more than ${sizeLabel(limits.maxTotalBytes)} of new or changed files to capture`,
        fileCount: indexCount + untrackedNew,
        totalBytes: newBytes,
      };
    }

    for (const candidate of toUntrack) toRemove.add(candidate);
    if (toRemove.size > 0) {
      await this.git(["update-index", "--force-remove", "-z", "--stdin"], { input: nulInput(toRemove) });
    }
    if (toUpdate.size > 0) await this.updateIndex([...toUpdate.keys()], skipped, signal);

    const tree = (await this.git(["write-tree"])).stdout.toString("utf8").trim();
    return { status: "ok", tree, skipped, fileCount: await this.indexCount(), layout };
  }

  /** update-index the paths, dropping (and reporting) any git cannot read. */
  private async updateIndex(paths: string[], skipped: SkippedFile[], signal?: AbortSignal): Promise<void> {
    let remaining = paths;
    for (let attempt = 0; attempt <= MAX_UPDATE_RETRIES; attempt += 1) {
      try {
        await this.git(["update-index", "--add", "--remove", "--replace", "-z", "--stdin"], {
          input: nulInput(remaining),
          timeoutMs: 10 * 60_000,
          ...(signal === undefined ? {} : { signal }),
        });
        return;
      } catch (error) {
        if (!(error instanceof GitError) || attempt === MAX_UPDATE_RETRIES) throw error;
        const beyondLink = /'(.+)' is beyond a symbolic link/u.exec(error.stderr)?.[1];
        const bad = beyondLink ?? parseUnprocessablePath(error.stderr);
        const match = bad === undefined || bad === null ? undefined : remaining.find((candidate) => toDisplay(candidate) === bad || candidate === bad);
        if (match === undefined) throw error;
        remaining = remaining.filter((candidate) => candidate !== match);
        if (beyondLink !== undefined) {
          // A symlink replaced one of its directories: the path is gone as far
          // as the workspace is concerned.
          await this.git(["update-index", "--force-remove", "-z", "--stdin"], { input: nulInput([match]) });
        } else {
          const info = await this.fileKind(match);
          if (info !== null) skipped.push({ path: match, reason: "unreadable", sizeBytes: info.kind === "file" ? info.size : null });
        }
        if (remaining.length === 0) return;
      }
    }
  }

  // ----------------------------------------------------------- snapshot

  private async commitTree(tree: string, subject: string): Promise<string> {
    return this.text(["commit-tree", "--no-gpg-sign", "-m", subject.length > 0 ? subject : "Rewind checkpoint", tree]);
  }

  private async setRefs(updates: ReadonlyArray<readonly [string, string]>, head: string | null): Promise<void> {
    let input = "";
    for (const [ref, sha] of updates) input += `update ${ref} ${sha}\n`;
    if (head !== null) input += `option no-deref\nupdate HEAD ${head}\n`;
    if (input.length > 0) await this.bare(["update-ref", "--stdin"], { input });
  }

  async hasCommit(sha: string): Promise<boolean> {
    const result = await this.bare(["cat-file", "-e", `${sha}^{commit}`], { okExitCodes: [0, 1, 128] });
    return result.exitCode === 0;
  }

  private async treeOf(commit: string): Promise<string> {
    return this.text(["rev-parse", "--verify", "-q", `${commit}^{tree}`]);
  }

  /**
   * Changes between two trees. `paths` are internal byte-string paths; they
   * travel as argv, which Node encodes as UTF-8, so they are converted to
   * their display form first.
   */
  async diffTrees(from: string, to: string, paths: readonly string[] | null = null): Promise<TreeChange[]> {
    if (from === to) return [];
    const args = ["diff-tree", "-r", "-z", "--no-renames", "--raw", "--numstat", "--no-ext-diff", "--no-textconv", from, to];
    const result = await this.bare(paths === null ? args : [...args, "--", ...paths.map(toDisplay)], { timeoutMs: 5 * 60_000 });
    return parseDiffTree(result.stdout);
  }

  private async headInfo(layout: RepoLayout): Promise<HeadInfo | null> {
    if (!layout.isGit) return null;
    try {
      return await readHead(this.workspace);
    } catch {
      return { sha: null, branch: null };
    }
  }

  /**
   * Capture, commit, and reference the workspace as checkpoint `id`. An
   * unchanged tree reuses the previous commit: the new ref costs nothing.
   */
  async snapshot(input: {
    checkpointId: string;
    subject: string;
    compareTo: string | null;
    limits: SnapshotLimits;
    force: boolean;
    signal?: AbortSignal;
  }): Promise<SnapshotResult> {
    const started = this.now();
    if (!(await this.workspaceExists())) return { status: "missing", reason: "The workspace directory does not exist." };
    const state = await this.ensure();
    if (state.unsupported !== null && !input.force && this.now() < state.unsupported.until) {
      const { reason, fileCount, totalBytes } = state.unsupported;
      return { status: "unsupported", reason, fileCount, totalBytes };
    }
    const captured = await this.capture({ limits: input.limits, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (captured.status === "unsupported") {
      state.unsupported = {
        reason: captured.reason,
        until: this.now() + UNSUPPORTED_RECHECK_MS,
        fileCount: captured.fileCount,
        totalBytes: captured.totalBytes,
      };
      await this.saveState();
      return captured;
    }
    state.unsupported = null;
    const result = await this.commitCaptured(captured, input.checkpointId, input.subject, input.compareTo);
    return { ...result, durationMs: this.now() - started };
  }

  private async commitCaptured(
    captured: Extract<CaptureResult, { status: "ok" }>,
    checkpointId: string,
    subject: string,
    compareTo: string | null,
  ): Promise<SnapshotOk> {
    const state = this.state!;
    const deduped = captured.tree === state.lastTree && state.lastCommit !== null;
    const commit = deduped ? state.lastCommit! : await this.commitTree(captured.tree, subject);
    await this.setRefs([[`refs/rewind/${checkpointId}`, commit]], commit);

    let comparedTo: string | null = null;
    if (compareTo !== null && (await this.hasCommit(compareTo))) comparedTo = await this.treeOf(compareTo);
    else if (state.lastTree !== null) comparedTo = state.lastTree;
    const changes = this.visible(await this.diffTrees(comparedTo ?? EMPTY_TREE, captured.tree));
    const head = await this.headInfo(captured.layout);

    state.lastTree = captured.tree;
    state.lastCommit = commit;
    state.lastSnapshotAt = this.now();
    await this.saveState();
    return {
      status: "ok",
      commit,
      tree: captured.tree,
      deduped,
      comparedTo,
      stats: statsOf(changes),
      changes: changes.slice(0, MAX_STORED_CHANGES).map(toFileChange),
      changesTruncated: changes.length > MAX_STORED_CHANGES,
      skipped: displaySkipped(captured.skipped),
      skippedCount: captured.skipped.length,
      head,
      fileCount: captured.fileCount,
      durationMs: 0,
    };
  }

  // --------------------------------------------------------------- diff

  private async resolveRevision(revision: Revision, limits: SnapshotLimits): Promise<
    { status: "ok"; tree: string; skipped: SkippedFile[] } | Exclude<DiffResult, { status: "ok" }>
  > {
    if (revision.kind === "empty") return { status: "ok", tree: EMPTY_TREE, skipped: [] };
    if (revision.kind === "checkpoint") {
      if (!(await this.hasCommit(revision.commit))) {
        return { status: "unavailable", reason: `Checkpoint ${revision.checkpointId} is not in this workspace's store.` };
      }
      return { status: "ok", tree: await this.treeOf(revision.commit), skipped: [] };
    }
    if (!(await this.workspaceExists())) return { status: "missing", reason: "The workspace directory does not exist." };
    const captured = await this.capture({ limits });
    if (captured.status === "unsupported") return captured;
    return { status: "ok", tree: captured.tree, skipped: captured.skipped };
  }

  async diff(input: {
    from: Revision;
    to: Revision;
    paths: readonly string[] | null;
    patch: boolean;
    maxFiles: number;
    maxPatchBytesPerFile: number;
    maxPatchBytesTotal: number;
    limits: SnapshotLimits;
  }): Promise<DiffResult> {
    if (!(await this.exists())) {
      if (input.from.kind === "checkpoint" || input.to.kind === "checkpoint") {
        return { status: "unavailable", reason: "This workspace has no checkpoints on this machine." };
      }
    }
    await this.ensure();
    const from = await this.resolveRevision(input.from, input.limits);
    if (from.status !== "ok") return from;
    const to = await this.resolveRevision(input.to, input.limits);
    if (to.status !== "ok") return to;
    const paths = input.paths === null ? null : input.paths.map(fromDisplay);
    const changes = this.visible(await this.diffTrees(from.tree, to.tree, paths)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const listed = changes.slice(0, input.maxFiles);
    const patches = new Map<string, { patch: string; truncated: boolean }>();
    if (input.patch && listed.length > 0) {
      const result = await this.bare(
        [
          "diff-tree",
          "-r",
          "-p",
          "--no-renames",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--full-index",
          from.tree,
          to.tree,
          "--",
          ...listed.map((change) => toDisplay(change.path)),
        ],
        { maxOutputBytes: input.maxPatchBytesTotal, truncateOutput: true, timeoutMs: 5 * 60_000 },
      );
      const chunks = splitPatch(result.stdout.toString("utf8"));
      let cursor = 0;
      for (const change of listed) {
        // A type change (file <-> symlink) prints as a deletion plus an
        // addition: two sections for one path.
        const sections = change.status === "T" ? 2 : 1;
        const own = chunks.slice(cursor, cursor + sections);
        cursor += sections;
        if (own.length === 0) break;
        const chunk = own.join("");
        if (!chunk.startsWith("diff --git ") || !chunk.slice(0, chunk.indexOf("\n")).includes(toDisplay(change.path))) {
          // Out of step with git's output order; stop rather than mislabel.
          break;
        }
        const reachedEnd = cursor >= chunks.length;
        if (Buffer.byteLength(chunk) > input.maxPatchBytesPerFile) {
          patches.set(change.path, { patch: Buffer.from(chunk).subarray(0, input.maxPatchBytesPerFile).toString("utf8"), truncated: true });
        } else {
          patches.set(change.path, { patch: chunk, truncated: result.truncated && reachedEnd });
        }
      }
    }
    const files: DiffFile[] = listed.map((change) => {
      const patch = patches.get(change.path);
      return { ...toFileChange(change), patch: patch?.patch ?? null, patchTruncated: patch?.truncated ?? (input.patch && patch === undefined) };
    });
    return {
      status: "ok",
      fromTree: from.tree,
      toTree: to.tree,
      files,
      totalFiles: changes.length,
      filesTruncated: changes.length > listed.length,
      stats: statsOf(changes),
      skipped: displaySkipped([...from.skipped, ...to.skipped]),
    };
  }

  // ------------------------------------------------------------ restore

  /** Copy a checkpoint from another workspace's shadow; null or the reason it failed. */
  private async importCommit(commit: string, checkpointId: string, sourceWorkspace: string): Promise<string | null> {
    const source = new Shadow(this.dataDir, sourceWorkspace, this.now);
    if (!(await source.exists())) return "the workspace it was taken in has no checkpoint store on this machine anymore";
    try {
      await this.bare(["fetch", "--no-tags", "--quiet", source.gitDir, `+refs/rewind/${checkpointId}:refs/rewind-import/${checkpointId}`], {
        timeoutMs: 10 * 60_000,
      });
    } catch (error) {
      return `copying it from ${sourceWorkspace} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return (await this.hasCommit(commit)) ? null : "it is no longer in the store it was taken in";
  }

  private async hasUncaptured(directory: string): Promise<boolean> {
    // A name that is not valid UTF-8 cannot be passed as a pathspec argument
    // intact; assume the worst so the directory is kept.
    if (fromDisplay(toDisplay(directory)) !== directory) return true;
    const result = await this.git(["ls-files", "-z", "--others", "--directory", "--no-empty-directory", "--", `${toDisplay(directory)}/`], {
      maxRecords: 1,
      truncateOutput: true,
    }).catch((error: unknown) => {
      if (error instanceof GitRecordLimitError) return null;
      throw error;
    });
    return result === null || result.stdout.length > 0;
  }

  /** Target tree with protected paths dropped or kept at their current state. */
  private async effectiveTree(targetTree: string, drop: readonly string[], keep: readonly TreeChange[]): Promise<string> {
    if (drop.length === 0 && keep.length === 0) return targetTree;
    const indexFile = path.join(this.root, `restore-index.${process.pid}.${this.now()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.bare(["read-tree", targetTree], { env });
      const records: Buffer[] = [];
      for (const removed of drop) records.push(Buffer.from(`0 ${NULL_SHA}\t`, "latin1"), internalToBuffer(removed), Buffer.from([0]));
      for (const change of keep) {
        if (change.oldMode === null || change.oldSha === null) {
          records.push(Buffer.from(`0 ${NULL_SHA}\t`, "latin1"), internalToBuffer(change.path), Buffer.from([0]));
        } else {
          records.push(Buffer.from(`${change.oldMode} ${change.oldSha}\t`, "latin1"), internalToBuffer(change.path), Buffer.from([0]));
        }
      }
      await this.bare(["update-index", "--add", "--replace", "-z", "--index-info"], { env, input: Buffer.concat(records) });
      return (await this.bare(["write-tree"], { env })).stdout.toString("utf8").trim();
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  private async verify(
    effectiveTree: string,
    deleted: readonly string[],
    skipped: readonly SkippedFile[],
  ): Promise<Verification> {
    const mismatches: Array<{ path: string; problem: string }> = [];
    await this.git(["update-index", "-q", "--refresh"], { okExitCodes: [0, 1] });
    const dirty = splitNul((await this.git(["diff-files", "--name-only", "-z"], { maxOutputBytes: 1024 * 1024, truncateOutput: true })).stdout);
    for (const record of dirty) mismatches.push({ path: toDisplay(toInternal(record)), problem: "content differs from the checkpoint" });
    for (const removed of deleted) {
      const info = await this.fileKind(removed);
      // On a case-insensitive filesystem a case-only rename leaves a file that
      // lstat finds under the old name; only an exact name match counts.
      if (info !== null && info.kind !== "dir" && (await this.existsExactly(removed))) {
        mismatches.push({ path: toDisplay(removed), problem: "still exists" });
      }
    }
    const indexTree = (await this.git(["write-tree"])).stdout.toString("utf8").trim();
    if (indexTree !== effectiveTree) mismatches.push({ path: ".", problem: "the shadow index does not match the checkpoint" });
    const skippedPaths = new Set(skipped.map((entry) => entry.path));
    const leftovers = splitNul(
      (await this.git(["ls-files", "-z", "--others", "--exclude-standard"], { maxOutputBytes: 1024 * 1024, truncateOutput: true })).stdout,
    )
      .map(toInternal)
      .filter((leftover) => !skippedPaths.has(leftover) && ![...skippedPaths].some((prefix) => leftover.startsWith(`${prefix}/`)));
    return {
      ok: mismatches.length === 0,
      mismatches: mismatches.slice(0, VERIFY_LIST_LIMIT),
      mismatchCount: mismatches.length,
      untouched: leftovers.slice(0, VERIFY_LIST_LIMIT).map(toDisplay),
      untouchedCount: leftovers.length,
    };
  }

  async restore(input: {
    target: { commit: string; checkpointId: string; sourceWorkspace: string | null };
    dryRun: boolean;
    preRestore: { checkpointId: string; subject: string } | null;
    limits: SnapshotLimits;
    maxListed: number;
    /** Cancels the preparation only; once files start changing, the restore finishes. */
    signal?: AbortSignal;
  }): Promise<RestoreResult> {
    const started = this.now();
    if (!(await this.workspaceExists())) return { status: "missing", reason: "The workspace directory does not exist." };
    const state = await this.ensure();

    if (!(await this.hasCommit(input.target.commit))) {
      const problem =
        input.target.sourceWorkspace === null
          ? "it is not in this workspace's store"
          : await this.importCommit(input.target.commit, input.target.checkpointId, input.target.sourceWorkspace);
      if (problem !== null) {
        return { status: "unavailable", reason: `Checkpoint ${input.target.checkpointId} cannot be restored here: ${problem}.` };
      }
    }
    const targetTree = await this.treeOf(input.target.commit);

    const captured = await this.capture({ limits: input.limits, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (captured.status === "unsupported") return captured;
    const currentTree = captured.tree;

    let preRestore: SnapshotOk | null = null;
    if (!input.dryRun) {
      // The undo point. If this fails, nothing below runs.
      preRestore = await this.commitCaptured(captured, input.preRestore!.checkpointId, input.preRestore!.subject, null);
      preRestore = { ...preRestore, durationMs: this.now() - started };
    }

    const allChanges = await this.diffTrees(currentTree, targetTree);
    // bb's chat copies stay exactly as they are, even against an older
    // checkpoint that still holds them: never written, never deleted.
    const leftAlone = allChanges.filter((change) => this.skipped(change.path));
    const changes = this.visible(allChanges);
    const layout = captured.layout;
    const plan = await planRestore(changes, {
      kind: async (candidate) => (await this.fileKind(candidate))?.kind ?? null,
      hasUncaptured: (directory) => this.hasUncaptured(directory),
      userIgnored: (paths) => userIgnoredPaths(this.workspace, layout, paths),
      caseInsensitive: state.caseInsensitive,
    });
    const effectiveTree = await this.effectiveTree(targetTree, plan.dropFromTarget, [...plan.keepCurrent, ...leftAlone]);

    const planDto: RestorePlan = {
      creates: plan.apply.filter((entry) => entry.action === "create").length,
      writes: plan.apply.filter((entry) => entry.action === "write").length,
      deletes: plan.apply.filter((entry) => entry.action === "delete").length,
      changes: plan.apply.slice(0, input.maxListed).map((entry) => ({
        path: toDisplay(entry.path),
        action: entry.action,
        binary: entry.change.binary,
        additions: entry.change.additions,
        deletions: entry.change.deletions,
      })),
      changesTruncated: plan.apply.length > input.maxListed,
      protected: plan.protect.slice(0, input.maxListed).map((entry) => ({
        path: toDisplay(entry.path),
        reason: entry.reason,
        action: entry.action,
      })),
      protectedCount: plan.protect.length,
    };
    const head = await this.headInfo(layout);
    const base = {
      status: "ok" as const,
      currentTree,
      targetTree,
      effectiveTree,
      plan: planDto,
      head,
      skipped: displaySkipped(captured.skipped),
      skippedCount: captured.skipped.length,
    };
    if (input.dryRun) {
      return { ...base, applied: false, preRestore: null, verification: null, applyError: null, durationMs: this.now() - started };
    }
    if (input.signal?.aborted) {
      return { ...base, applied: false, preRestore, verification: null, applyError: "The restore was cancelled before any file changed.", durationMs: this.now() - started };
    }

    // From here on the undo point exists. Nothing below may throw: a failure
    // is reported with the pre-restore checkpoint so the caller can undo.
    let applied = false;
    try {
      if (effectiveTree !== currentTree) {
        applied = true;
        await this.applyTree(currentTree, effectiveTree, input.limits);
      }
      const deleted = plan.apply.filter((entry) => entry.action === "delete").map((entry) => entry.path);
      const verification = await this.verify(effectiveTree, deleted, captured.skipped);

      const resultCommit =
        effectiveTree === targetTree ? input.target.commit : await this.commitTree(effectiveTree, `Rewind: restored ${input.target.checkpointId} (protected paths kept)`);
      await this.setRefs([], resultCommit);
      state.lastTree = effectiveTree;
      state.lastCommit = resultCommit;
      await this.saveState();
      return { ...base, applied: true, preRestore, verification, applyError: null, durationMs: this.now() - started };
    } catch (error) {
      // The state still describes the pre-restore checkpoint: a failed
      // read-tree leaves the shadow index as it was, and the next capture
      // picks up whatever files did change from the workspace itself.
      return {
        ...base,
        applied,
        preRestore,
        verification: null,
        applyError: error instanceof Error ? error.message : String(error),
        durationMs: this.now() - started,
      };
    }
  }

  /**
   * `read-tree -m -u`, retried a few times when files are locked (on Windows,
   * another program has them open). An attempt that fails part way has
   * written some files, so each retry first captures the workspace as it is
   * now and applies the rest from there.
   */
  private async applyTree(from: string, to: string, limits: SnapshotLimits): Promise<void> {
    let current = from;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.git(["read-tree", "-m", "-u", current, to], { timeoutMs: 10 * 60_000 });
        return;
      } catch (error) {
        const delay = APPLY_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !(error instanceof GitError) || !LOCKED_FILE.test(error.stderr)) throw error;
        await sleep(delay);
        const recaptured = await this.capture({ limits });
        if (recaptured.status !== "ok") throw error;
        current = recaptured.tree;
      }
    }
  }

  /** The commit and tree a checkpoint's ref points at, if it exists. */
  async refCommit(checkpointId: string): Promise<{ commit: string | null; tree: string | null }> {
    if (!(await this.exists())) return { commit: null, tree: null };
    const result = await this.bare(["rev-parse", "-q", "--verify", `refs/rewind/${checkpointId}^{commit}`], { okExitCodes: [0, 1, 128] });
    const commit = result.stdout.toString("utf8").trim();
    if (!/^[0-9a-f]{40}$/u.test(commit)) return { commit: null, tree: null };
    return { commit, tree: await this.treeOf(commit) };
  }

  // ---------------------------------------------------------- lifecycle

  private async listRefs(prefixes: readonly string[]): Promise<string[]> {
    const output = await this.text(["for-each-ref", "--format=%(refname)", ...prefixes]);
    return output.length === 0 ? [] : output.split("\n");
  }

  private async deleteRefNames(refs: readonly string[]): Promise<number> {
    if (refs.length === 0) return 0;
    for (let start = 0; start < refs.length; start += 5_000) {
      const input = refs
        .slice(start, start + 5_000)
        .map((ref) => `delete ${ref}\n`)
        .join("");
      await this.bare(["update-ref", "--stdin"], { input });
    }
    return refs.length;
  }

  async deleteCheckpoints(ids: readonly string[]): Promise<number> {
    if (!(await this.exists())) return 0;
    const existing = new Set(await this.listRefs(["refs/rewind/"]));
    return this.deleteRefNames(ids.map((id) => `refs/rewind/${id}`).filter((ref) => existing.has(ref)));
  }

  /** Drop refs the server no longer knows (older than `minAgeMs`). */
  async deleteUnknownRefs(keep: ReadonlySet<string>, minAgeMs: number): Promise<number> {
    if (!(await this.exists())) return 0;
    const cutoff = this.now() - minAgeMs;
    const stale = (await this.listRefs(["refs/rewind/", "refs/rewind-import/"])).filter((ref) => {
      const id = ref.slice(ref.lastIndexOf("/") + 1);
      const created = idTime(id);
      if (created === null || created > cutoff) return false;
      return ref.startsWith("refs/rewind-import/") || !keep.has(id);
    });
    return this.deleteRefNames(stale);
  }

  /** Repack and prune objects no checkpoint references. */
  async gc(): Promise<void> {
    if (!(await this.exists())) return;
    await this.bare(["gc", "--quiet", "--prune=2.hours.ago"], { timeoutMs: 20 * 60_000 });
  }

  async refCount(): Promise<number | null> {
    if (!(await this.exists())) return null;
    return (await this.listRefs(["refs/rewind/"])).length;
  }
}

/** Total bytes under a directory, stopping after `maxEntries` entries. */
export async function directorySize(root: string, maxEntries = 500_000): Promise<number | null> {
  let total = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > maxEntries) return null;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        try {
          total += (await lstat(full)).size;
        } catch {
          // Removed while walking.
        }
      }
    }
  }
  return total;
}

export async function listShadowStates(dataDir: string): Promise<Array<{ key: string; state: ShadowState | null }>> {
  let names: string[];
  try {
    names = await readdir(shadowsRoot(dataDir));
  } catch {
    return [];
  }
  const out: Array<{ key: string; state: ShadowState | null }> = [];
  for (const name of names) {
    if (!/^[0-9a-f]{16,64}$/u.test(name)) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(shadowsRoot(dataDir), name, "state.json"), "utf8")) as ShadowState;
      out.push({ key: name, state: parsed });
    } catch {
      out.push({ key: name, state: null });
    }
  }
  return out;
}

