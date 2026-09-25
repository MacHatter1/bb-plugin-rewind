import { describe, expect, it } from "vitest";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import { OUTPUT_BUDGET_BYTES, capOutput, formatPlan, statsLabel } from "../../src/format";
import { CHECKPOINT_ID_PATTERN, newId } from "../../src/ids";
import { idTime } from "../../src/host/shadow";
import { anchorForCheckpoint, conversationRows, excerpt, percentile, toCheckpointDto } from "../../src/service";
import type { CheckpointRow } from "../../src/store";
import { groupTurns, type TurnCheckpoint } from "../../src/turns";

describe("ids", () => {
  it("are time-ordered, ref-safe, and carry their creation time", () => {
    const earlier = newId("ck", 1_790_000_000_000);
    const later = newId("ck", 1_790_000_000_001);
    expect(earlier < later).toBe(true);
    expect(CHECKPOINT_ID_PATTERN.test(earlier)).toBe(true);
    expect(idTime(earlier)).toBe(1_790_000_000_000);
  });
});

describe("output bounds", () => {
  it("caps text below the CLI output limit", () => {
    const capped = capOutput("x".repeat(PLUGIN_CLI_OUTPUT_MAX_BYTES * 2));
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    expect(capped).toContain("output truncated");
    expect(capOutput("short")).toBe("short");
  });

  it("never splits a multi-byte character", () => {
    const capped = capOutput("é".repeat(100), 51);
    expect(capped).not.toContain("�");
  });

  it("keeps message excerpts short and single-line", () => {
    expect(excerpt("  a\n\nb  ")).toBe("a b");
    expect(excerpt("x".repeat(500))!.length).toBe(160);
    expect(excerpt("   ")).toBeNull();
  });
});

describe("formatting", () => {
  it("labels stats", () => {
    expect(statsLabel({ stats: { files: 2, insertions: 5, deletions: 1 }, baseline: false, status: "ok" })).toBe("2 files +5 -1");
    expect(statsLabel({ stats: { files: 40, insertions: 0, deletions: 0 }, baseline: true, status: "ok" })).toBe("40 files (baseline)");
    expect(statsLabel({ stats: { files: 0, insertions: 0, deletions: 0 }, baseline: false, status: "ok" })).toBe("no changes");
  });

  it("explains protected paths in plans", () => {
    const lines = formatPlan(
      {
        creates: 0,
        writes: 1,
        deletes: 0,
        changes: [{ path: "a.txt", action: "write", binary: false, additions: 1, deletions: 2 }],
        changesTruncated: false,
        protected: [{ path: ".env", reason: "ignored", action: "write" }],
        protectedCount: 1,
      },
      { applied: false },
    );
    expect(lines[0]).toBe("Files that would change: 1 written, 0 created, 0 deleted, 1 left alone.");
    expect(lines.join("\n")).toContain(".env  ignored by the repository");
  });

  it("computes percentiles", () => {
    expect(percentile([1, 2, 3, 4, 100], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 0.95)).toBe(100);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("checkpoints from before bb's chat copies were left out", () => {
  it("do not show those copies, and their stats leave them out", () => {
    const row = {
      id: "ck_test",
      stats: { files: 4, insertions: 1_500, deletions: 240 },
      changes: [
        { path: ".bb/chats/thr_1/thread.json", status: "M", oldMode: "100644", newMode: "100644", binary: false, additions: 3, deletions: 2 },
        { path: ".bb/chats/thr_1/history/turn_1/page-1.json", status: "A", oldMode: null, newMode: "100644", binary: false, additions: 1_490, deletions: 235 },
        { path: ".bb/plugins.json", status: "M", oldMode: "100644", newMode: "100644", binary: false, additions: 1, deletions: 1 },
        { path: "src/app.ts", status: "M", oldMode: "100644", newMode: "100644", binary: false, additions: 6, deletions: 2 },
      ],
      changesTruncated: false,
    } as unknown as CheckpointRow;
    const dto = toCheckpointDto(row);
    expect(dto.changes.map((change) => change.path)).toEqual([".bb/plugins.json", "src/app.ts"]);
    expect(dto.stats).toEqual({ files: 2, insertions: 7, deletions: 3 });
    const clean = { ...row, changes: row.changes.slice(2), stats: { files: 2, insertions: 7, deletions: 3 } } as CheckpointRow;
    expect(toCheckpointDto(clean)).toMatchObject({ changes: clean.changes, stats: clean.stats });
  });
});

describe("turn grouping", () => {
  const at = (id: string, kind: TurnCheckpoint["kind"], attempt: TurnCheckpoint["attempt"] = null): TurnCheckpoint => ({ id, kind, attempt, messageExcerpt: id, createdAt: 0 });

  it("pairs before- and after-turn checkpoints and keeps steers and restores separate", () => {
    const groups = groupTurns([
      at("b1", "before-turn", "start-turn"),
      at("s1", "before-turn", "join-turn"),
      at("m1", "manual"),
      at("a1", "after-turn"),
      at("p1", "pre-restore"),
      at("m2", "manual"),
      at("b2", "before-turn", "start-turn"),
    ]);
    expect(groups.map((group) => [group.kind, group.turn, group.before?.id ?? null, group.after?.id ?? null, group.extras.map((extra) => extra.id)])).toEqual([
      ["turn", 1, "b1", "a1", ["s1", "m1"]],
      ["restore", null, null, "p1", []],
      ["manual", null, null, "m2", []],
      ["turn", 2, "b2", null, []],
    ]);
  });
});

describe("fork anchors", () => {
  const rows = conversationRows([
    { kind: "conversation", role: "user", sourceSeqEnd: 1 },
    { kind: "turn", children: [{ kind: "conversation", role: "assistant", sourceSeqEnd: 5 }] },
    { kind: "conversation", role: "user", sourceSeqEnd: 8 },
    { kind: "conversation", role: "assistant", sourceSeqEnd: 12 },
  ]);

  it("branches before the message a before-turn checkpoint preceded", () => {
    expect(anchorForCheckpoint({ kind: "before-turn", eventMark: 7 }, rows)).toBe(8);
    expect(anchorForCheckpoint({ kind: "before-turn", eventMark: 0 }, rows)).toBe(1);
  });

  it("branches after the last reply other checkpoints include", () => {
    expect(anchorForCheckpoint({ kind: "after-turn", eventMark: 7 }, rows)).toBe(5);
    expect(anchorForCheckpoint({ kind: "manual", eventMark: 13 }, rows)).toBe(12);
    expect(anchorForCheckpoint({ kind: "after-turn", eventMark: null }, rows)).toBeUndefined();
  });
});
