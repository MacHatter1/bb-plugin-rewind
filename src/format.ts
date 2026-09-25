// Plain-text rendering for the CLI and the agent tools. Everything here is
// bounded: callers pass the result through `capOutput`.
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import type { DiffFile, RestorePlan, SkippedFile, Verification } from "./host-contract";
import type { CheckpointDto, ForkJob, RestoreDto, RestoreOutcome, UndoneEffect } from "./rpc-contract";
import { turnEffectsSentence, undoneEffectsSentence } from "./effect-text";
import { groupTurns } from "./turns";

/** Leave room for the JSON envelope and stderr under the CLI output cap. */
export const OUTPUT_BUDGET_BYTES = Math.floor(PLUGIN_CLI_OUTPUT_MAX_BYTES * 0.85);

export function capOutput(text: string, budget = OUTPUT_BUDGET_BYTES): string {
  if (Buffer.byteLength(text) <= budget) return text;
  const note = "\n… output truncated to stay under the CLI output limit; narrow it with --path or --stat.\n";
  let cut = Buffer.from(text).subarray(0, budget - Buffer.byteLength(note)).toString("utf8");
  // Drop a trailing partial character the byte cut may have produced.
  cut = cut.replace(/�$/u, "");
  return cut + note;
}

/** "1 checkpoint", "2 checkpoints". */
export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

export function formatTime(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const time = date.toTimeString().slice(0, 8);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay ? time : `${date.toISOString().slice(0, 10)} ${time}`;
}

export function kindLabel(checkpoint: Pick<CheckpointDto, "kind" | "attempt" | "label">): string {
  switch (checkpoint.kind) {
    case "before-turn":
      return checkpoint.label === "Thread start" ? "thread start" : checkpoint.attempt === "join-turn" ? "before steer" : "before turn";
    case "after-turn":
      return "after turn";
    case "manual":
      return "manual";
    case "pre-restore":
      return "before restore";
  }
}

export function statsLabel(checkpoint: Pick<CheckpointDto, "stats" | "baseline" | "status">): string {
  if (checkpoint.stats === null) return "";
  const { files, insertions, deletions } = checkpoint.stats;
  if (checkpoint.baseline) return `${files} file${files === 1 ? "" : "s"} (baseline)`;
  if (files === 0) return "no changes";
  return `${files} file${files === 1 ? "" : "s"} +${insertions} -${deletions}`;
}

function flags(checkpoint: CheckpointDto): string[] {
  const out: string[] = [];
  if (checkpoint.status === "pending") out.push("capturing");
  if (checkpoint.status === "failed") out.push(`failed: ${checkpoint.error ?? "unknown error"}`);
  if (checkpoint.status === "unsupported") out.push(`unsupported: ${checkpoint.error ?? "workspace too large"}`);
  if (checkpoint.late) out.push(`late: may include the start of ${checkpoint.kind === "after-turn" ? "the next turn" : "the turn"}`);
  if (checkpoint.skippedCount > 0) out.push(`${checkpoint.skippedCount} skipped`);
  return out;
}

export function checkpointLine(checkpoint: CheckpointDto, now = Date.now()): string {
  const parts = [checkpoint.id, formatTime(checkpoint.createdAt, now), kindLabel(checkpoint)];
  const stats = statsLabel(checkpoint);
  if (stats.length > 0) parts.push(stats);
  const label = checkpoint.label !== null && checkpoint.label !== "Thread start" ? checkpoint.label : null;
  if (label !== null) parts.push(`"${label}"`);
  const extra = flags(checkpoint);
  if (extra.length > 0) parts.push(`[${extra.join("; ")}]`);
  return parts.join("  ");
}

export function formatList(input: { threadId: string; checkpoints: CheckpointDto[]; restores: RestoreDto[]; workspace: { path: string } | null; now?: number }): string {
  const now = input.now ?? Date.now();
  const lines: string[] = [];
  lines.push(`Checkpoints for ${input.threadId}${input.workspace === null ? "" : ` (${input.workspace.path})`}`);
  if (input.checkpoints.length === 0) {
    lines.push("", "No checkpoints yet. One is taken before and after every turn, or run `bb rewind checkpoint`.");
    return lines.join("\n");
  }
  const groups = groupTurns(input.checkpoints).reverse();
  for (const group of groups) {
    lines.push("");
    if (group.kind === "turn") {
      lines.push(`Turn ${group.turn}${group.excerpt === null ? "" : `: "${group.excerpt}"`}`);
    } else if (group.kind === "restore") {
      lines.push("Restore");
    } else {
      lines.push("Manual checkpoint");
    }
    const members = [group.before, ...group.extras, group.after].filter((entry): entry is CheckpointDto => entry !== null);
    for (const member of members) lines.push(`  ${checkpointLine(member, now)}`);
  }
  if (input.restores.length > 0) {
    lines.push("", "Restores (newest last):");
    for (const restore of input.restores.slice(-10)) lines.push(`  ${restoreLine(restore, now)}`);
  }
  return lines.join("\n");
}

export function restoreLine(restore: RestoreDto, now = Date.now()): string {
  const summary = restore.summary;
  const counts = summary === null ? "" : `  ${summary.writes} written, ${summary.creates} created, ${summary.deletes} deleted${summary.protectedCount > 0 ? `, ${summary.protectedCount} left alone` : ""}`;
  const state = restore.status === "failed" ? `  [failed: ${restore.error ?? "unknown"}]` : restore.status === "unverified" ? "  [not verified]" : "";
  const undone = restore.undoneBy === null ? "" : `  (undone by ${restore.undoneBy})`;
  return `${restore.id}  ${formatTime(restore.createdAt, now)}  ${restore.kind} to ${restore.targetCheckpointId}${counts}${state}${undone}`;
}

export function formatSkipped(skipped: readonly SkippedFile[], total: number): string[] {
  if (total === 0) return [];
  const reason = (entry: SkippedFile) =>
    entry.reason === "too-large"
      ? `over the size cap${entry.sizeBytes === null ? "" : ` (${(entry.sizeBytes / 1024 / 1024).toFixed(1)} MB)`}`
      : entry.reason === "nested-repository"
        ? "nested repository"
        : "unreadable";
  const lines = [`Skipped (not captured, never touched by a restore): ${total}`];
  for (const entry of skipped) lines.push(`  ${entry.path}  ${reason(entry)}`);
  if (total > skipped.length) lines.push(`  … and ${total - skipped.length} more`);
  return lines;
}

export function formatShow(checkpoint: CheckpointDto, now = Date.now()): string {
  const lines = [
    `${checkpoint.id}  ${kindLabel(checkpoint)}  ${formatTime(checkpoint.createdAt, now)}`,
    `Thread:     ${checkpoint.threadId}`,
    `Workspace:  ${checkpoint.workspace} (${checkpoint.hostId})`,
    `Status:     ${checkpoint.status}${checkpoint.error === null ? "" : ` (${checkpoint.error})`}${checkpoint.late ? ", late" : ""}`,
  ];
  if (checkpoint.label !== null) lines.push(`Label:      ${checkpoint.label}`);
  if (checkpoint.messageExcerpt !== null) lines.push(`Message:    ${checkpoint.messageExcerpt}`);
  if (checkpoint.head !== null) {
    lines.push(`Git HEAD:   ${checkpoint.head.sha?.slice(0, 12) ?? "(no commits)"}${checkpoint.head.branch === null ? " (detached)" : ` on ${checkpoint.head.branch}`}`);
  }
  if (checkpoint.eventMark !== null) lines.push(`Event mark: ${checkpoint.eventMark}`);
  const outside = checkpoint.effects === null ? null : turnEffectsSentence(checkpoint.effects);
  if (outside !== null) {
    lines.push(`Outside:    ${outside.replace(/^This turn/u, "Since the previous checkpoint, the agent")}`);
    for (const effect of checkpoint.effects ?? []) lines.push(`              ${effect.command}`);
  }
  if (checkpoint.durationMs !== null) lines.push(`Took:       ${checkpoint.durationMs} ms${checkpoint.deduped ? " (unchanged tree, reused)" : ""}`);
  if (checkpoint.stats !== null) {
    lines.push("", `Changes ${checkpoint.baseline ? "(baseline: every captured file)" : "since the thread's previous checkpoint"}: ${statsLabel(checkpoint)}`);
    for (const change of checkpoint.changes) {
      const counts = change.binary ? "binary" : `+${change.additions ?? 0} -${change.deletions ?? 0}`;
      lines.push(`  ${change.status} ${change.path}  ${counts}`);
    }
    if (checkpoint.changesTruncated) lines.push("  … more changes not listed (see `bb rewind diff --stat`)");
  }
  const skipped = formatSkipped(checkpoint.skipped, checkpoint.skippedCount);
  if (skipped.length > 0) lines.push("", ...skipped);
  return lines.join("\n");
}

export function formatDiffStat(files: readonly DiffFile[], total: number, stats: { files: number; insertions: number; deletions: number }): string {
  if (total === 0) return "No differences.";
  const width = Math.min(60, Math.max(...files.map((file) => file.path.length)));
  const lines = files.map((file) => {
    const counts = file.binary ? "binary" : `+${file.additions ?? 0} -${file.deletions ?? 0}`;
    return ` ${file.status} ${file.path.padEnd(width)}  ${counts}`;
  });
  if (total > files.length) lines.push(` … and ${total - files.length} more files`);
  lines.push(` ${stats.files} file${stats.files === 1 ? "" : "s"} changed, +${stats.insertions} -${stats.deletions}`);
  return lines.join("\n");
}

export function formatDiffPatch(files: readonly DiffFile[], total: number): string {
  if (total === 0) return "No differences.";
  const parts: string[] = [];
  for (const file of files) {
    if (file.patch === null) {
      parts.push(`diff --git a/${file.path} b/${file.path}\n(patch omitted: output limit reached)\n`);
      continue;
    }
    parts.push(file.patch.endsWith("\n") ? file.patch : `${file.patch}\n`);
    if (file.patchTruncated) parts.push(`(patch for ${file.path} truncated)\n`);
  }
  if (total > files.length) parts.push(`… ${total - files.length} more files not shown; use --stat or --path.\n`);
  return parts.join("");
}

const PROTECT_REASONS: Record<string, string> = {
  "exists-uncaptured": "exists but is not captured (ignored, over the size cap, or in a nested repository)",
  "directory-has-uncaptured": "its directory holds files that are not captured",
  "blocked-by-uncaptured": "a parent path is an uncaptured file or symlink",
  ignored: "ignored by the repository",
  unverifiable: "git could not check its ignore rules",
};

export function formatPlan(plan: RestorePlan, options: { applied: boolean }): string[] {
  const counts = `${plan.writes} written, ${plan.creates} created, ${plan.deletes} deleted${plan.protectedCount > 0 ? `, ${plan.protectedCount} left alone` : ""}`;
  const lines = [options.applied ? `Files: ${counts}.` : `Files that would change: ${counts}.`];
  for (const change of plan.changes) {
    const counts = change.binary ? "binary" : change.action === "delete" ? "" : `+${change.additions ?? 0} -${change.deletions ?? 0}`;
    lines.push(`  ${change.action.padEnd(6)} ${change.path}${counts.length > 0 ? `  ${counts}` : ""}`);
  }
  if (plan.changesTruncated) lines.push("  … more changes not listed");
  if (plan.protectedCount > 0) {
    lines.push(`Left alone (${plan.protectedCount}):`);
    for (const entry of plan.protected) lines.push(`  ${entry.path}  ${PROTECT_REASONS[entry.reason] ?? entry.reason}`);
    if (plan.protectedCount > plan.protected.length) lines.push(`  … and ${plan.protectedCount - plan.protected.length} more`);
  }
  return lines;
}

export function formatPreview(preview: {
  checkpoint: CheckpointDto;
  plan: RestorePlan;
  skipped: SkippedFile[];
  skippedCount: number;
  headMoved: boolean;
  currentHead: { sha: string | null; branch: string | null } | null;
  workspace: { path: string; running: Array<{ id: string; title: string | null; status: string }> };
  effects?: UndoneEffect[];
}): string {
  const lines = [`Dry run: restore ${preview.checkpoint.id} (${kindLabel(preview.checkpoint)}, ${formatTime(preview.checkpoint.createdAt)}) into ${preview.workspace.path}`, ""];
  if (preview.plan.writes + preview.plan.creates + preview.plan.deletes === 0 && preview.plan.protectedCount === 0) {
    lines.push("The workspace already matches this checkpoint.");
  } else {
    lines.push(...formatPlan(preview.plan, { applied: false }));
  }
  if (preview.headMoved) {
    lines.push(
      "",
      `Warning: git HEAD moved since this checkpoint (${preview.checkpoint.head?.sha?.slice(0, 12) ?? "?"} -> ${preview.currentHead?.sha?.slice(0, 12) ?? "?"}). Rewind restores files only; commits and branches stay as they are.`,
    );
  }
  if (preview.checkpoint.late) {
    lines.push("", `Note: this checkpoint was taken late and may include the start of ${preview.checkpoint.kind === "after-turn" ? "the next turn" : "its turn"}.`);
  }
  if (preview.workspace.running.length > 0) {
    lines.push("", `Blocked: ${preview.workspace.running.map((thread) => `${thread.title ?? thread.id} (${thread.id}) is ${thread.status}`).join(", ")}. Stop it before restoring.`);
  }
  lines.push(...formatUndoneEffects(preview.effects ?? []));
  const skipped = formatSkipped(preview.skipped, preview.skippedCount);
  if (skipped.length > 0) lines.push("", ...skipped);
  lines.push("", "Nothing was changed. Apply with --yes; every restore can be undone with `bb rewind undo`.");
  return lines.join("\n");
}

export function formatVerification(verification: Verification | null): string[] {
  if (verification === null) return [];
  if (verification.ok) {
    const untouched = verification.untouchedCount > 0 ? ` ${verification.untouchedCount} file(s) that were ignored before the restore are still there.` : "";
    return [`Verified: the workspace matches the checkpoint.${untouched}`];
  }
  const lines = [`Verification found ${verification.mismatchCount} mismatch(es):`];
  for (const mismatch of verification.mismatches) lines.push(`  ${mismatch.path}: ${mismatch.problem}`);
  return lines;
}

export type EditResult =
  | { ok: true; requestSequence: number; message: number | null }
  | { ok: false; error: string; message: number | null };

export function formatRestoreOutcome(outcome: RestoreOutcome, verb: "Restored" | "Undid"): string {
  const lines = [
    verb === "Restored"
      ? `Restored checkpoint ${outcome.restore.targetCheckpointId} (${outcome.restore.id}).`
      : `Undid the restore: files are back as of ${outcome.restore.targetCheckpointId} (${outcome.restore.id}).`,
    ...formatPlan(outcome.plan, { applied: true }),
    ...formatVerification(outcome.verification),
    ...outcome.warnings.map((warning) => `Warning: ${warning}`),
    ...formatUndoneEffects(outcome.effects),
  ];
  if (outcome.preRestore !== null) lines.push(`Undo point: ${outcome.preRestore.id}. Run \`bb rewind undo\` to put the files back.`);
  if (outcome.note !== null) lines.push("", ...formatNote(outcome.note));
  return lines.join("\n");
}

/** Commands in the undone turns whose effects outside the workspace stay. */
export function formatUndoneEffects(effects: readonly UndoneEffect[]): string[] {
  const sentence = undoneEffectsSentence(effects);
  if (sentence === null) return [];
  return ["", `Outside the workspace: ${sentence}`, ...effects.map((effect) => `  ${effect.turn === null ? "latest turn" : `turn ${effect.turn}`}: ${effect.command}`)];
}

/** The conversation still has the undone turns: suggest a note (never sent by Rewind). */
export function formatNote(note: string): string[] {
  return ["The conversation still includes the undone turns. Suggested note for your next message:", `  ${note}`];
}

export function formatEditResult(edit: EditResult): string[] {
  const which = edit.message === null ? "the message" : `message ${edit.message}`;
  return edit.ok
    ? [`Replaced ${which}: bb discarded it and every later turn, and the new message starts a turn on the restored files.`]
    : [`The files stay restored, but bb did not edit ${which}: ${edit.error}`];
}

export function formatForkJob(job: ForkJob): string {
  if (job.status === "done") return `Forked into ${job.forkThreadId} with the files of ${job.checkpointId}.`;
  if (job.status === "failed") return `Fork failed: ${job.error ?? "unknown error"}`;
  return `Fork ${job.id} is running (${job.step ?? "starting"})${job.forkThreadId === null ? "" : `; new thread ${job.forkThreadId}`}. Check it with \`bb plugin rpc call rewind forkStatus\`.`;
}
