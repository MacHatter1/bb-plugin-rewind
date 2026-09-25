// Browser-safe display helpers for the app (no Node APIs, no SDK runtime).
import type { CheckpointDto } from "../rpc-contract";

export function kindLabel(checkpoint: Pick<CheckpointDto, "kind" | "attempt" | "label">): string {
  switch (checkpoint.kind) {
    case "before-turn":
      if (checkpoint.label === "Thread start") return "Thread start";
      return checkpoint.attempt === "join-turn" ? "Before steer" : "Before message";
    case "after-turn":
      return "After reply";
    case "manual":
      return "Manual";
    case "pre-restore":
      return "Before restore";
  }
}

export function clockTime(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

export function filesLabel(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** Why a checkpoint is flagged late, by kind. */
export function lateNote(kind: string): string {
  return kind === "after-turn"
    ? "This checkpoint was taken after the next turn had started, so it may already include some of that turn's edits."
    : "This checkpoint finished after its turn had started, so it may already include some of that turn's edits.";
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

export const PROTECT_REASON_LABELS: Record<string, string> = {
  "exists-uncaptured": "exists but is not captured (ignored, over the size cap, or a nested repository)",
  "directory-has-uncaptured": "its folder holds files that are not captured",
  "blocked-by-uncaptured": "a parent path is an uncaptured file or symlink",
  ignored: "ignored by the repository",
  unverifiable: "git could not check its ignore rules",
};

export const SKIP_REASON_LABELS: Record<string, string> = {
  "too-large": "over the size cap",
  "nested-repository": "nested repository",
  unreadable: "unreadable",
};
