// Per-key async mutex. The host worker is the only writer of a shadow
// repository. Workspace keys serialize snapshots, restores and diffs;
// maintenance keys serialize repacking, GC and shadow removal separately.

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

type Waiter = { write: boolean; enter: () => void };
const gates = new Map<string, { readers: number; writer: boolean; queue: Waiter[] }>();

/** Fair host-wide gate: GC drains readers before changing shared object lifetime. */
export async function withReadWriteLock<T>(key: string, write: boolean, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let gate = gates.get(key);
  if (gate === undefined) { gate = { readers: 0, writer: false, queue: [] }; gates.set(key, gate); }
  const state = gate;
  const drain = () => {
    if (state.writer) return;
    while (state.queue.length > 0) {
      const next = state.queue[0]!;
      if (next.write && state.readers > 0) return;
      state.queue.shift();
      if (next.write) state.writer = true; else state.readers++;
      next.enter();
      if (next.write) return;
    }
    if (state.readers === 0) gates.delete(key);
  };
  let waiter!: Waiter;
  let cancel: (() => void) | undefined;
  await new Promise<void>((resolve, reject) => {
    waiter = { write, enter: resolve };
    cancel = () => {
      const index = state.queue.indexOf(waiter);
      if (index < 0) return;
      state.queue.splice(index, 1); drain();
      reject(signal?.reason ?? new Error("Work cancelled"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    state.queue.push(waiter); drain();
  }).finally(() => { if (cancel !== undefined) signal?.removeEventListener("abort", cancel); });
  try { signal?.throwIfAborted(); return await fn(); }
  finally { if (write) state.writer = false; else state.readers--; drain(); }
}
