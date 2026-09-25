// Runs git with a controlled environment. Every Rewind git process goes
// through here so timeouts, cancellation, and output caps apply uniformly.
import { spawn, type ChildProcess } from "node:child_process";

export class GitError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly args: readonly string[];
  constructor(message: string, args: readonly string[], exitCode: number | null, stderr: string) {
    super(message);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Thrown when stdout passes `maxRecords` NUL-terminated records. */
export class GitRecordLimitError extends Error {
  readonly records: number;
  constructor(records: number) {
    super(`git output passed ${records} records`);
    this.name = "GitRecordLimitError";
    this.records = records;
  }
}

export interface GitRunOptions {
  cwd: string;
  input?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Stop reading and fail past this many stdout bytes (default 64 MiB). */
  maxOutputBytes?: number;
  /** Return what was read so far instead of failing when output is capped. */
  truncateOutput?: boolean;
  /** Kill the process once stdout holds this many NUL-terminated records. */
  maxRecords?: number;
  /** Exit codes treated as success (default `[0]`). */
  okExitCodes?: readonly number[];
  /** Extra environment variables for this call. */
  env?: Readonly<Record<string, string>>;
}

export interface GitRunResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const KILL_GRACE_MS = 2_000;

const running = new Set<ChildProcess>();

let baseEnv: NodeJS.ProcessEnv | null = null;

/**
 * The daemon passes the user's PATH and HOME; drop every GIT_* variable so
 * nothing inherited can redirect a command at another repository, index, or
 * object store, and pin identity, locale, and prompts.
 */
export function gitBaseEnv(): NodeJS.ProcessEnv {
  if (baseEnv !== null) return baseEnv;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("GIT_")) continue;
    if (key === "EDITOR" || key === "VISUAL" || key === "PAGER") continue;
    env[key] = value;
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_AUTHOR_NAME: "Rewind",
    GIT_AUTHOR_EMAIL: "rewind@localhost",
    GIT_COMMITTER_NAME: "Rewind",
    GIT_COMMITTER_EMAIL: "rewind@localhost",
    LC_ALL: "C",
    LANG: "C",
    PAGER: "cat",
  });
  baseEnv = env;
  return env;
}

/** Tests change HOME to fake a global git config; forget the cached env. */
export function resetGitBaseEnv(): void {
  baseEnv = null;
}

/** Kill every git process this worker started (worker dispose). */
export function killAllGit(): void {
  for (const child of running) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function countNul(chunk: Buffer): number {
  let count = 0;
  let index = chunk.indexOf(0);
  while (index !== -1) {
    count += 1;
    index = chunk.indexOf(0, index + 1);
  }
  return count;
}

export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const okExitCodes = options.okExitCodes ?? [0];
  return new Promise<GitRunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GitError("git call aborted before start", args, null, ""));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn("git", [...args], {
        cwd: options.cwd,
        env: options.env === undefined ? gitBaseEnv() : { ...gitBaseEnv(), ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(new GitError(`could not start git: ${String(error)}`, args, null, ""));
      return;
    }
    running.add(child);
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let records = 0;
    let stderr = "";
    let truncated = false;
    let failure: Error | null = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const stop = (reason: Error | null) => {
      if (reason !== null && failure === null) failure = reason;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      stop(new GitError(`git ${args.find((arg) => !arg.startsWith("-")) ?? ""} timed out after ${timeoutMs} ms`, args, null, stderr));
    }, timeoutMs);
    const onAbort = () => stop(new GitError("git call aborted", args, null, stderr));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      if (options.maxRecords !== undefined) {
        records += countNul(chunk);
        if (records > options.maxRecords) {
          truncated = true;
          stop(new GitRecordLimitError(records));
          return;
        }
      }
      if (stdoutBytes + chunk.length > maxOutput) {
        const room = maxOutput - stdoutBytes;
        if (room > 0) chunks.push(chunk.subarray(0, room));
        stdoutBytes = maxOutput;
        truncated = true;
        stop(options.truncateOutput ? null : new GitError(`git output passed ${maxOutput} bytes`, args, null, stderr));
        return;
      }
      chunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8").slice(0, MAX_STDERR - stderr.length);
    });
    child.stdin?.on("error", () => {
      // git may exit before reading all input (e.g. killed); the exit code reports it.
    });
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      running.delete(child);
    };
    child.on("error", (error) => {
      const gitError = new GitError(`git failed to run: ${error.message}`, args, null, stderr);
      if (child.pid === undefined && !settled) {
        // Spawn itself failed (git missing, cwd gone); no close event follows reliably.
        cleanup();
        reject(gitError);
        return;
      }
      stop(gitError);
    });
    child.on("close", (code) => {
      if (settled) return;
      cleanup();
      if (failure !== null) {
        reject(failure);
        return;
      }
      const exitCode = code ?? -1;
      const stdout = Buffer.concat(chunks);
      if (!okExitCodes.includes(exitCode) && !(truncated && options.truncateOutput)) {
        const verb = args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? "";
        const detail = stderr.trim().split("\n").slice(-3).join(" | ");
        reject(new GitError(`git ${verb} exited ${exitCode}${detail ? `: ${detail}` : ""}`, args, exitCode, stderr));
        return;
      }
      resolve({ exitCode, stdout, stderr, truncated });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

/** Split NUL-terminated output into records (the trailing empty one dropped). */
export function splitNul(buffer: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let index = buffer.indexOf(0); index !== -1; index = buffer.indexOf(0, start)) {
    out.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) out.push(buffer.subarray(start));
  return out;
}

/** Host-internal path strings are byte strings: one char per byte (latin1). */
export function toInternal(bytes: Buffer): string {
  return bytes.toString("latin1");
}
export function internalToBuffer(path: string): Buffer {
  return Buffer.from(path, "latin1");
}
/** Display form of an internal path (UTF-8 decoded; lossy only for invalid UTF-8). */
export function toDisplay(path: string): string {
  return Buffer.from(path, "latin1").toString("utf8");
}
/** Internal form of a display path that came from the RPC boundary. */
export function fromDisplay(path: string): string {
  return Buffer.from(path, "utf8").toString("latin1");
}

/** NUL-joined stdin for `-z --stdin` commands. */
export function nulInput(paths: Iterable<string>): Buffer {
  const parts: Buffer[] = [];
  for (const path of paths) {
    parts.push(internalToBuffer(path), Buffer.from([0]));
  }
  return Buffer.concat(parts);
}
