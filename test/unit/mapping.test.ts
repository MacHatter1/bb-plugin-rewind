import { describe, expect, it } from "vitest";
import { resolveMessageCheckpoint, type MappingCheckpoint, type MappingRestore } from "../../src/mapping";

let seq = 0;
function cp(id: string, kind: MappingCheckpoint["kind"], eventMark: number | null, extra: Partial<MappingCheckpoint> = {}): MappingCheckpoint {
  seq += 1;
  return { id, seq, kind, attempt: kind === "before-turn" ? "start-turn" : null, status: "ok", eventMark, ...extra };
}

// A thread: baseline at mark 0, message 1 (seq 1), reply (seq 5), turn ends
// (after-turn at 6), message 2 dispatched at mark 6 (event 7), reply at 11.
function twoTurns() {
  seq = 0;
  return [cp("base", "before-turn", 0), cp("after1", "after-turn", 6), cp("before2", "before-turn", 6), cp("after2", "after-turn", 12)];
}

describe("user messages map to the checkpoint taken before them", () => {
  it("finds each message's own before-turn checkpoint", () => {
    const checkpoints = twoTurns();
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "user", sourceSeqEnd: 1 })).toMatchObject({ match: "exact", checkpointId: "base" });
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "user", sourceSeqEnd: 7 })).toMatchObject({ match: "exact", checkpointId: "before2" });
  });

  it("accepts a mark equal to the message's own sequence (events appended before the hook)", () => {
    seq = 0;
    const checkpoints = [cp("base", "before-turn", 0), cp("after1", "after-turn", 6), cp("before2", "before-turn", 7)];
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "user", sourceSeqEnd: 7 })).toMatchObject({ match: "exact", checkpointId: "before2" });
  });

  it("falls back to the end of the previous turn when the message's own snapshot failed", () => {
    seq = 0;
    const checkpoints = [cp("base", "before-turn", 0), cp("after1", "after-turn", 6), cp("before2", "before-turn", 6, { status: "failed" })];
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "user", sourceSeqEnd: 7 })).toMatchObject({ match: "fallback", checkpointId: "after1" });
  });

  it("does not hand an earlier message's checkpoint to a later message", () => {
    seq = 0;
    // Message 2 has no before-turn checkpoint at all (e.g. the plugin was off).
    const checkpoints = [cp("base", "before-turn", 0), cp("after1", "after-turn", 6)];
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "user", sourceSeqEnd: 7 })).toMatchObject({ match: "fallback", checkpointId: "after1" });
  });

  it("prefers a restore that ran after the last checkpoint", () => {
    seq = 0;
    const checkpoints = [cp("base", "before-turn", 0), cp("after1", "after-turn", 6), cp("pre", "pre-restore", 6)];
    // Restores sit just after their pre-restore checkpoint (seq 3).
    const restores: MappingRestore[] = [{ id: "rs", seq: 3.5, targetCheckpointId: "base", status: "ok", eventMark: 6 }];
    const result = resolveMessageCheckpoint(checkpoints, restores, { role: "user", sourceSeqEnd: 7 });
    expect(result).toMatchObject({ match: "fallback", checkpointId: "base" });
  });

  it("does not prefer a restore that ran before the latest checkpoint", () => {
    seq = 0;
    const checkpoints = [cp("base", "before-turn", 0), cp("pre", "pre-restore", 2), cp("after1", "after-turn", 6)];
    const restores: MappingRestore[] = [{ id: "rs", seq: 2.5, targetCheckpointId: "base", status: "ok", eventMark: 2 }];
    expect(resolveMessageCheckpoint(checkpoints, restores, { role: "user", sourceSeqEnd: 7 })).toMatchObject({ match: "fallback", checkpointId: "after1" });
  });

  it("does not hand a message the checkpoint from before a restore that stopped part way", () => {
    seq = 0;
    // Turn 1 changed nothing, so it left no after-turn checkpoint; then a
    // restore failed half way through writing files.
    const checkpoints = [cp("before1", "before-turn", 0), cp("pre", "pre-restore", 5)];
    const restores: MappingRestore[] = [{ id: "rs", seq: 2.5, targetCheckpointId: "before1", status: "failed", eventMark: 5 }];
    const result = resolveMessageCheckpoint(checkpoints, restores, { role: "user", sourceSeqEnd: 6 });
    expect(result.match).toBe("fallback");
  });

  it("uses a steer's own mid-turn checkpoint", () => {
    seq = 0;
    const checkpoints = [cp("base", "before-turn", 0), cp("steer", "before-turn", 3, { attempt: "join-turn" }), cp("after1", "after-turn", 9)];
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "user", sourceSeqEnd: 4 })).toMatchObject({ match: "exact", checkpointId: "steer" });
  });

  it("reports none when nothing precedes the message", () => {
    seq = 0;
    expect(resolveMessageCheckpoint([cp("late", "before-turn", 20)], [], { role: "user", sourceSeqEnd: 3 })).toMatchObject({ match: "none", checkpointId: null });
  });

  it("ignores checkpoints without a mark", () => {
    seq = 0;
    expect(resolveMessageCheckpoint([cp("nomark", "before-turn", null)], [], { role: "user", sourceSeqEnd: 3 }).match).toBe("none");
  });
});

describe("assistant replies map to the checkpoint taken after their turn", () => {
  it("finds the after-turn checkpoint of the reply's turn", () => {
    const checkpoints = twoTurns();
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "assistant", sourceSeqEnd: 5 })).toMatchObject({ match: "exact", checkpointId: "after1" });
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "assistant", sourceSeqEnd: 11 })).toMatchObject({ match: "exact", checkpointId: "after2" });
  });

  it("maps every reply in one turn to the same checkpoint", () => {
    const checkpoints = twoTurns();
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "assistant", sourceSeqEnd: 2 }).checkpointId).toBe("after1");
  });

  it("falls back to the next message's before-turn checkpoint when the turn's own is missing", () => {
    seq = 0;
    const checkpoints = [cp("base", "before-turn", 0), cp("before2", "before-turn", 6), cp("after2", "after-turn", 12)];
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "assistant", sourceSeqEnd: 5 })).toMatchObject({ match: "fallback", checkpointId: "before2" });
  });

  it("skips mid-turn steer checkpoints", () => {
    seq = 0;
    const checkpoints = [cp("base", "before-turn", 0), cp("steer", "before-turn", 3, { attempt: "join-turn" }), cp("after1", "after-turn", 9)];
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "assistant", sourceSeqEnd: 2 }).checkpointId).toBe("after1");
  });

  it("says the turn is still running when it is", () => {
    seq = 0;
    const result = resolveMessageCheckpoint([cp("base", "before-turn", 0)], [], { role: "assistant", sourceSeqEnd: 4 }, { turnRunning: true });
    expect(result.match).toBe("none");
    expect(result.note).toContain("still running");
  });

  it("uses a pending checkpoint (still capturing) but never a failed one", () => {
    seq = 0;
    const checkpoints = [cp("after1", "after-turn", 6, { status: "failed" }), cp("before2", "before-turn", 6, { status: "pending" })];
    expect(resolveMessageCheckpoint(checkpoints, [], { role: "assistant", sourceSeqEnd: 5 })).toMatchObject({ match: "fallback", checkpointId: "before2" });
  });
});
