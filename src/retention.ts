// Retention selection. Pure: given what exists, decide what to delete.
//
// - Keep each thread's newest `maxPerThread` checkpoints, plus any checkpoint
//   the thread's latest restore points at (so "Undo restore" keeps working).
// - Drop every checkpoint of a thread archived more than `retentionDays` ago.
// - Drop every checkpoint of a thread that no longer exists.

export interface RetentionCheckpoint {
  id: string;
  threadId: string;
  seq: number;
  status: "pending" | "ok" | "failed" | "unsupported";
}

export interface RetentionThread {
  id: string;
  /** Null when the thread is not archived; undefined when it no longer exists. */
  archivedAt: number | null;
}

export interface RetentionInput {
  checkpoints: readonly RetentionCheckpoint[];
  threads: ReadonlyMap<string, RetentionThread | null>;
  /** Checkpoint ids each thread's restores still reference. */
  protectedIds: ReadonlySet<string>;
  maxPerThread: number;
  retentionDays: number;
  now: number;
}

export interface RetentionDecision {
  deleteIds: string[];
  reasons: Record<string, "over-limit" | "archived" | "thread-gone" | "failed">;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Failed attempts are only kept long enough to explain a gap in the UI. */
const FAILED_KEEP_MS = 7 * DAY_MS;

export function selectForDeletion(input: RetentionInput, failedCreatedAt: ReadonlyMap<string, number> = new Map()): RetentionDecision {
  const byThread = new Map<string, RetentionCheckpoint[]>();
  for (const checkpoint of input.checkpoints) {
    const list = byThread.get(checkpoint.threadId) ?? [];
    list.push(checkpoint);
    byThread.set(checkpoint.threadId, list);
  }
  const deleteIds: string[] = [];
  const reasons: RetentionDecision["reasons"] = {};
  const drop = (id: string, reason: RetentionDecision["reasons"][string]) => {
    if (reasons[id] !== undefined) return;
    reasons[id] = reason;
    deleteIds.push(id);
  };

  for (const [threadId, list] of byThread) {
    const thread = input.threads.get(threadId);
    if (!input.threads.has(threadId)) continue; // unknown: leave it for the next pass
    if (thread === null) {
      for (const checkpoint of list) drop(checkpoint.id, "thread-gone");
      continue;
    }
    if (thread !== undefined && thread.archivedAt !== null && input.now - thread.archivedAt > input.retentionDays * DAY_MS) {
      for (const checkpoint of list) drop(checkpoint.id, "archived");
      continue;
    }
    const newestFirst = [...list].sort((a, b) => b.seq - a.seq);
    let kept = 0;
    for (const checkpoint of newestFirst) {
      if (checkpoint.status === "failed" || checkpoint.status === "unsupported") {
        const createdAt = failedCreatedAt.get(checkpoint.id);
        if (createdAt !== undefined && input.now - createdAt > FAILED_KEEP_MS) drop(checkpoint.id, "failed");
        continue;
      }
      if (input.protectedIds.has(checkpoint.id)) continue;
      kept += 1;
      if (kept > input.maxPerThread) drop(checkpoint.id, "over-limit");
    }
  }
  return { deleteIds, reasons };
}
