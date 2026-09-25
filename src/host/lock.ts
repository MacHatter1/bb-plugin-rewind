// Per-key async mutex. The host worker is the only writer of a shadow
// repository, so serializing by shadow key serializes every git operation on
// that workspace: snapshots from the dispatch gate, restores, diffs, and GC.

const tails = new Map<string, Promise<void>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** Number of keys with queued or running work (tests and status). */
export function activeLockCount(): number {
  return tails.size;
}
