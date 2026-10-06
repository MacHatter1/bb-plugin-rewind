// Per-key async mutex. The host worker is the only writer of a shadow
// repository, so serializing by shadow key serializes every git operation on
// that workspace: snapshots from the dispatch gate, restores, diffs, and GC.

import { realpath, stat } from "node:fs/promises";

/** Coordination only: historical shadow addresses remain based on their raw paths. */
export async function workspaceIdentity(workspace: string): Promise<{ identity: string; canonicalPath: string }> {
  const canonicalPath = await realpath(workspace);
  const info = await stat(canonicalPath, { bigint: true });
  if (!info.isDirectory()) throw new Error("Workspace is not a directory");
  return { identity: `${info.dev}:${info.ino}:${info.ino === 0n ? canonicalPath : ""}`, canonicalPath };
}

const tails = new Map<string, Promise<void>>();

export async function withLock<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  let onAbort: (() => void) | undefined;
  try {
    await (signal === undefined ? previous : Promise.race([previous, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("Work cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]));
    signal?.throwIfAborted();
    return await fn();
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    release();
    // A cancelled waiter releases its own slot, not the predecessor's lock.
    // Keep the tail registered until that predecessor has actually settled.
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  }
}

/** Number of keys with queued or running work (tests and status). */
export function activeLockCount(): number {
  return tails.size;
}
