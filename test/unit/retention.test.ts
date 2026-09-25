import { describe, expect, it } from "vitest";
import { selectForDeletion, type RetentionCheckpoint } from "../../src/retention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function checkpoints(threadId: string, count: number, status: RetentionCheckpoint["status"] = "ok"): RetentionCheckpoint[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${threadId}-${index}`, threadId, seq: index, status }));
}

describe("retention selection", () => {
  it("keeps each thread's newest checkpoints up to the limit", () => {
    const decision = selectForDeletion({
      checkpoints: checkpoints("a", 5),
      threads: new Map([["a", { id: "a", archivedAt: null }]]),
      protectedIds: new Set(),
      maxPerThread: 3,
      retentionDays: 14,
      now: NOW,
    });
    expect(decision.deleteIds.sort()).toEqual(["a-0", "a-1"]);
    expect(decision.reasons["a-0"]).toBe("over-limit");
  });

  it("never deletes checkpoints the latest restore needs for undo", () => {
    const decision = selectForDeletion({
      checkpoints: checkpoints("a", 5),
      threads: new Map([["a", { id: "a", archivedAt: null }]]),
      protectedIds: new Set(["a-0"]),
      maxPerThread: 3,
      retentionDays: 14,
      now: NOW,
    });
    expect(decision.deleteIds).toEqual(["a-1"]);
  });

  it("drops every checkpoint of a thread archived longer than the retention period", () => {
    const decision = selectForDeletion({
      checkpoints: [...checkpoints("old", 2), ...checkpoints("recent", 2)],
      threads: new Map([
        ["old", { id: "old", archivedAt: NOW - 15 * DAY }],
        ["recent", { id: "recent", archivedAt: NOW - 13 * DAY }],
      ]),
      protectedIds: new Set(),
      maxPerThread: 200,
      retentionDays: 14,
      now: NOW,
    });
    expect(decision.deleteIds.sort()).toEqual(["old-0", "old-1"]);
    expect(decision.reasons["old-0"]).toBe("archived");
  });

  it("drops checkpoints of deleted threads and leaves unknown ones for later", () => {
    const decision = selectForDeletion({
      checkpoints: [...checkpoints("gone", 1), ...checkpoints("unknown", 1)],
      threads: new Map([["gone", null]]),
      protectedIds: new Set(),
      maxPerThread: 200,
      retentionDays: 14,
      now: NOW,
    });
    expect(decision.deleteIds).toEqual(["gone-0"]);
    expect(decision.reasons["gone-0"]).toBe("thread-gone");
  });

  it("does not count failed attempts against the limit and expires them after a week", () => {
    const failed = checkpoints("a", 2, "failed");
    const decision = selectForDeletion(
      {
        checkpoints: [...failed, ...checkpoints("a", 3).map((checkpoint) => ({ ...checkpoint, id: `ok-${checkpoint.id}`, seq: checkpoint.seq + 10 }))],
        threads: new Map([["a", { id: "a", archivedAt: null }]]),
        protectedIds: new Set(),
        maxPerThread: 3,
        retentionDays: 14,
        now: NOW,
      },
      new Map([
        ["a-0", NOW - 8 * DAY],
        ["a-1", NOW - DAY],
      ]),
    );
    expect(decision.deleteIds).toEqual(["a-0"]);
    expect(decision.reasons["a-0"]).toBe("failed");
  });
});
