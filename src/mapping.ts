// Mapping chat messages to checkpoints. Pure.
//
// Every checkpoint stores the thread's event high-water mark (the latest
// event sequence when it was taken). A message reference carries
// `sourceSeqEnd`, the last event sequence it covers. Order is creation order.
//
// - A user message's "before" checkpoint is the before-turn checkpoint taken
//   when it was dispatched: the latest before-turn checkpoint whose mark is at
//   or below the message's sourceSeqEnd, provided no after-turn checkpoint
//   was taken after it (that would mean it belongs to an earlier turn).
//   Without one, the latest checkpoint or restore at or below the mark is the
//   fallback: the files as they were at the end of the previous turn.
// - An assistant reply's "after" checkpoint is the after-turn checkpoint of
//   its turn: the first after-turn checkpoint with a mark at or above the
//   reply's sourceSeqEnd. If the turn's after-turn snapshot is missing, the
//   next turn's before-turn checkpoint (or a pre-restore one) is next best.

export type MappingKind = "before-turn" | "after-turn" | "manual" | "pre-restore";

export interface MappingCheckpoint {
  id: string;
  seq: number;
  kind: MappingKind;
  attempt: "start-turn" | "join-turn" | null;
  status: "pending" | "ok" | "failed" | "unsupported";
  eventMark: number | null;
}

/**
 * A restore that changed files, or may have (one that stopped part way).
 * `seq` orders it among the checkpoints: callers place it just after its
 * pre-restore checkpoint.
 */
export interface MappingRestore {
  id: string;
  seq: number;
  targetCheckpointId: string;
  status: "ok" | "unverified" | "failed";
  eventMark: number | null;
}

export interface MessageRef {
  role: "user" | "assistant";
  sourceSeqEnd: number;
}

export type MappingMatch =
  | { match: "exact"; checkpointId: string; note: string }
  | { match: "fallback"; checkpointId: string; note: string }
  | { match: "none"; checkpointId: null; note: string };

const usable = (checkpoint: MappingCheckpoint) => checkpoint.status === "ok" || checkpoint.status === "pending";

export function resolveMessageCheckpoint(
  checkpoints: readonly MappingCheckpoint[],
  restores: readonly MappingRestore[],
  message: MessageRef,
  options: { turnRunning?: boolean } = {},
): MappingMatch {
  const ordered = [...checkpoints].filter((checkpoint) => checkpoint.eventMark !== null).sort((a, b) => a.seq - b.seq);
  const mark = message.sourceSeqEnd;
  return message.role === "user" ? beforeUser(ordered, restores, mark) : afterAssistant(ordered, mark, options.turnRunning === true);
}

function beforeUser(ordered: readonly MappingCheckpoint[], restores: readonly MappingRestore[], mark: number): MappingMatch {
  const atOrBefore = ordered.filter((checkpoint) => checkpoint.eventMark! <= mark);
  const lastAfterTurnSeq = Math.max(
    -1,
    ...atOrBefore.filter((checkpoint) => checkpoint.kind === "after-turn" && usable(checkpoint)).map((checkpoint) => checkpoint.seq),
  );
  // Any restore, even one that stopped part way, changed the files after the
  // checkpoints before it; only a finished one is a state to fall back to.
  const lastRestoreSeq = Math.max(
    -1,
    ...restores.filter((restore) => restore.eventMark !== null && restore.eventMark <= mark).map((restore) => restore.seq),
  );

  // The dispatch checkpoint of this very message: the latest before-turn one,
  // unless a turn ended (or a restore ran) after it, in which case it belongs
  // to an earlier message.
  const own = [...atOrBefore].reverse().find((checkpoint) => checkpoint.kind === "before-turn");
  if (own !== undefined && own.seq > lastAfterTurnSeq && own.seq > lastRestoreSeq && usable(own)) {
    return { match: "exact", checkpointId: own.id, note: "Files as they were when this message was sent." };
  }

  // Fallback: the latest state we know of before the message.
  const candidates = atOrBefore.filter((checkpoint) => usable(checkpoint) && checkpoint.kind !== "pre-restore");
  const latest = candidates.at(-1);
  const restore = [...restores]
    .filter((entry) => entry.status !== "failed" && entry.eventMark !== null && entry.eventMark <= mark)
    .sort((a, b) => a.seq - b.seq)
    .at(-1);
  if (restore !== undefined && (latest === undefined || restore.seq > latest.seq)) {
    return {
      match: "fallback",
      checkpointId: restore.targetCheckpointId,
      note: "This message has no checkpoint of its own; showing the files a restore put back just before it.",
    };
  }
  if (latest !== undefined) {
    return {
      match: "fallback",
      checkpointId: latest.id,
      note: `This message has no checkpoint of its own; showing the closest earlier one (${latest.kind}). Edits made between that checkpoint and the message are not in it.`,
    };
  }
  return { match: "none", checkpointId: null, note: "No checkpoint was taken before this message." };
}

function afterAssistant(ordered: readonly MappingCheckpoint[], mark: number, turnRunning: boolean): MappingMatch {
  const after = ordered.filter((checkpoint) => checkpoint.eventMark! >= mark && usable(checkpoint));
  const found = after.find(
    (checkpoint) =>
      checkpoint.kind === "after-turn" ||
      checkpoint.kind === "pre-restore" ||
      (checkpoint.kind === "before-turn" && checkpoint.attempt !== "join-turn"),
  );
  if (found !== undefined) {
    if (found.kind === "after-turn") {
      return { match: "exact", checkpointId: found.id, note: "Files as they were when this reply's turn ended." };
    }
    return {
      match: "fallback",
      checkpointId: found.id,
      note:
        found.kind === "pre-restore"
          ? "The turn's own after-turn checkpoint is missing; showing the files as they were just before a later restore."
          : "The turn's own after-turn checkpoint is missing; showing the files as they were when the next message was sent.",
    };
  }
  return {
    match: "none",
    checkpointId: null,
    note: turnRunning ? "This turn is still running; its checkpoint is taken when it ends." : "No checkpoint was taken after this reply.",
  };
}
