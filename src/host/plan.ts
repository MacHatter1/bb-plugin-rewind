// Restore planning. Pure: the filesystem and ignore checks come in through
// `PlanProbe`, so the rules are unit-testable without git.
//
// The invariant: a restore changes only paths whose current content is in
// the pre-restore checkpoint (so undo can bring them back) or paths that do
// not exist. Anything else that exists — ignored files, files over the size
// cap, nested repositories — is protected, and the effective target keeps the
// current state for it. git's own checkout treats ignored files as
// expendable, which is why this check runs before `read-tree -u`.
import type { PlanAction, ProtectReason } from "../host-contract";
import type { TreeChange } from "./parse";

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface PlanProbe {
  /** lstat the workspace path; null when it does not exist. */
  kind(path: string): Promise<EntryKind | null>;
  /** True when the directory holds anything the current checkpoint lacks. */
  hasUncaptured(directory: string): Promise<boolean>;
  /**
   * Paths the workspace repository's own rules ignore (empty for non-git),
   * and paths git could not answer for (beyond a symlink, inside a submodule).
   */
  userIgnored(paths: readonly string[]): Promise<{ ignored: ReadonlySet<string>; unknown: ReadonlySet<string> }>;
  /** True on case-insensitive filesystems. */
  caseInsensitive: boolean;
}

export interface PlannedChange {
  path: string;
  action: PlanAction;
  change: TreeChange;
}

export interface ProtectedChange {
  path: string;
  action: PlanAction;
  reason: ProtectReason;
  change: TreeChange;
}

export interface RestorePlanResult {
  apply: PlannedChange[];
  protect: ProtectedChange[];
  /** Target entries to drop from the effective tree (protected creates). */
  dropFromTarget: string[];
  /** Current entries to keep in the effective tree (protected writes/deletes). */
  keepCurrent: TreeChange[];
}

export function actionFor(change: TreeChange): PlanAction {
  if (change.status === "A") return "create";
  if (change.status === "D") return "delete";
  return "write";
}

function ancestors(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let index = 1; index < parts.length; index += 1) out.push(parts.slice(0, index).join("/"));
  return out;
}

/**
 * Classify the current→target changes into applied and protected ones.
 * `changes` is `git diff-tree -r` output between the current (pre-restore)
 * tree and the target tree.
 */
export async function planRestore(changes: readonly TreeChange[], probe: PlanProbe): Promise<RestorePlanResult> {
  const kinds = new Map<string, EntryKind | null>();
  const kindOf = async (path: string) => {
    if (!kinds.has(path)) kinds.set(path, await probe.kind(path));
    return kinds.get(path) ?? null;
  };
  const fold = (path: string) => (probe.caseInsensitive ? path.toLowerCase() : path);

  // Paths the current tree has that the target removes or retypes: git will
  // remove these itself, so they never block a create.
  const leaving = new Set<string>();
  for (const change of changes) {
    if (change.status === "D" || change.status === "T") leaving.add(fold(change.path));
  }

  const { ignored, unknown } = await probe.userIgnored(changes.map((change) => change.path));

  const protect: ProtectedChange[] = [];
  const protectedDirectories: string[] = [];
  const blockedCreates = new Set<string>();

  for (const change of changes) {
    if (change.status !== "A") continue;
    const path = change.path;
    // A path git cannot check (e.g. beyond a symlink the restore removes) is
    // still created: it does not exist, so creating it cannot lose anything.
    if (ignored.has(path)) {
      protect.push({ path, action: "create", reason: "ignored", change });
      blockedCreates.add(path);
      continue;
    }
    let reason: ProtectReason | null = null;
    // Once an ancestor is missing, or is a captured file/symlink git removes
    // first, nothing exists at the path yet; never look through a symlink.
    let pathMayExist = true;
    for (const ancestor of ancestors(path)) {
      const kind = await kindOf(ancestor);
      if (kind === "dir") continue;
      if (kind === null || leaving.has(fold(ancestor))) {
        pathMayExist = false;
        break;
      }
      reason = "blocked-by-uncaptured";
      break;
    }
    if (reason === null && pathMayExist) {
      const kind = await kindOf(path);
      if (kind === "dir") {
        if (await probe.hasUncaptured(path)) {
          reason = "directory-has-uncaptured";
          protectedDirectories.push(path);
        }
      } else if (kind !== null && !leaving.has(fold(path))) {
        reason = "exists-uncaptured";
      }
    }
    if (reason !== null) {
      protect.push({ path, action: "create", reason, change });
      blockedCreates.add(path);
    }
  }

  const keepCurrent: TreeChange[] = [];
  const apply: PlannedChange[] = [];
  for (const change of changes) {
    const action = actionFor(change);
    if (change.status === "A") {
      if (!blockedCreates.has(change.path)) apply.push({ path: change.path, action, change });
      continue;
    }
    const insideProtectedDirectory = protectedDirectories.some((directory) => change.path.startsWith(`${directory}/`));
    if (ignored.has(change.path)) {
      protect.push({ path: change.path, action, reason: "ignored", change });
      keepCurrent.push(change);
    } else if (unknown.has(change.path)) {
      // An existing path git cannot vouch for: leave it as it is.
      protect.push({ path: change.path, action, reason: "unverifiable", change });
      keepCurrent.push(change);
    } else if (insideProtectedDirectory) {
      // The directory stays (its uncaptured files would be lost), so the
      // captured files inside it stay too.
      protect.push({ path: change.path, action, reason: "directory-has-uncaptured", change });
      keepCurrent.push(change);
    } else {
      apply.push({ path: change.path, action, change });
    }
  }

  return { apply, protect, dropFromTarget: [...blockedCreates], keepCurrent };
}
