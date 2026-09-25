// Plugin SQLite storage: checkpoint and restore metadata, fork jobs, and gate
// latency samples. Rows are ordered by rowid (insertion order), which is the
// order checkpoints were started in — what message mapping needs.
import type Database from "better-sqlite3";
import type { ChangeStats, CheckpointKind, FileChange, HeadInfo, SkippedFile } from "./host-contract";

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    project_id TEXT,
    environment_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    attempt TEXT,
    status TEXT NOT NULL,
    late INTEGER NOT NULL DEFAULT 0,
    event_mark INTEGER,
    message_excerpt TEXT,
    commit_sha TEXT,
    tree_sha TEXT,
    deduped INTEGER NOT NULL DEFAULT 0,
    head_sha TEXT,
    head_branch TEXT,
    is_git INTEGER NOT NULL DEFAULT 0,
    baseline INTEGER NOT NULL DEFAULT 0,
    files_changed INTEGER,
    insertions INTEGER,
    deletions INTEGER,
    changes_json TEXT,
    changes_truncated INTEGER NOT NULL DEFAULT 0,
    skipped_json TEXT,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER,
    duration_ms INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  )`,
  `CREATE INDEX checkpoints_thread ON checkpoints(thread_id)`,
  `CREATE INDEX checkpoints_workspace ON checkpoints(host_id, workspace)`,
  `CREATE TABLE restores (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_checkpoint_id TEXT NOT NULL,
    pre_restore_checkpoint_id TEXT,
    status TEXT NOT NULL,
    event_mark INTEGER,
    summary_json TEXT,
    error TEXT,
    undone_by TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX restores_thread ON restores(thread_id)`,
  `CREATE TABLE forks (
    id TEXT PRIMARY KEY,
    source_thread_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    anchor_seq INTEGER,
    fork_thread_id TEXT,
    status TEXT NOT NULL,
    step TEXT,
    error TEXT,
    prompt TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE gate_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT,
    checkpoint_id TEXT,
    outcome TEXT NOT NULL,
    waited_ms INTEGER NOT NULL,
    snapshot_ms INTEGER,
    created_at INTEGER NOT NULL
  )`,
  // "proceed" or "wait"; waited_ms is how long the hook held the message.
  `ALTER TABLE gate_samples ADD COLUMN decision TEXT`,
  // Messages Rewind queued (a "wait" decision), until they are released.
  `CREATE TABLE gate_waits (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    environment_id TEXT,
    kind TEXT NOT NULL,
    checkpoint_id TEXT,
    row_ids_json TEXT,
    created_at INTEGER NOT NULL,
    recheck_at INTEGER,
    reattempt_at INTEGER,
    dispatched_at INTEGER,
    closed_at INTEGER,
    closed_by TEXT
  )`,
  `CREATE INDEX gate_waits_thread ON gate_waits(thread_id)`,
  // The suggested note for a thread's next message after a restore that left
  // the conversation as it was.
  `CREATE TABLE notes (
    thread_id TEXT PRIMARY KEY,
    restore_id TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Commands with effects outside the workspace, run since the previous checkpoint.
  `ALTER TABLE checkpoints ADD COLUMN effects_json TEXT`,
];

export type CheckpointStatus = "pending" | "ok" | "failed" | "unsupported";
export type DispatchAttempt = "start-turn" | "join-turn";

export interface CheckpointRow {
  seq: number;
  id: string;
  threadId: string;
  projectId: string | null;
  environmentId: string;
  hostId: string;
  workspace: string;
  kind: CheckpointKind;
  label: string | null;
  attempt: DispatchAttempt | null;
  status: CheckpointStatus;
  late: boolean;
  eventMark: number | null;
  messageExcerpt: string | null;
  commit: string | null;
  tree: string | null;
  deduped: boolean;
  head: HeadInfo | null;
  baseline: boolean;
  stats: ChangeStats | null;
  changes: FileChange[];
  changesTruncated: boolean;
  skipped: SkippedFile[];
  skippedCount: number;
  fileCount: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
  /** Null until the commands since the previous checkpoint were scanned. */
  effects: StoredEffect[] | null;
}

/** A command with effects outside the workspace (see src/effects.ts). */
export interface StoredEffect {
  kind: string;
  label: string;
  command: string;
}

export type GateWaitKind = "snapshot" | "restore";

export interface GateWaitRow {
  id: string;
  threadId: string;
  environmentId: string | null;
  kind: GateWaitKind;
  checkpointId: string | null;
  rowIds: string[];
  createdAt: number;
  recheckAt: number | null;
  reattemptAt: number | null;
  dispatchedAt: number | null;
  closedAt: number | null;
  closedBy: string | null;
}

export interface NoteRow {
  threadId: string;
  restoreId: string | null;
  text: string;
  createdAt: number;
}

export type RestoreKind = "restore" | "undo" | "fork";
export type RestoreStatus = "ok" | "unverified" | "failed";

export interface RestoreSummary {
  creates: number;
  writes: number;
  deletes: number;
  protectedCount: number;
  verified: boolean;
  mismatchCount: number;
  untouchedCount: number;
}

export interface RestoreRow {
  seq: number;
  id: string;
  threadId: string;
  environmentId: string;
  hostId: string;
  workspace: string;
  kind: RestoreKind;
  targetCheckpointId: string;
  preRestoreCheckpointId: string | null;
  status: RestoreStatus;
  eventMark: number | null;
  summary: RestoreSummary | null;
  error: string | null;
  undoneBy: string | null;
  createdAt: number;
}

export type ForkStatus = "running" | "done" | "failed";

export interface ForkRow {
  id: string;
  sourceThreadId: string;
  checkpointId: string;
  anchorSeq: number | null;
  forkThreadId: string | null;
  status: ForkStatus;
  step: string | null;
  error: string | null;
  prompt: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GateSample {
  checkpointId: string | null;
  outcome: string;
  /** "proceed" or "wait"; null for samples from before the queueing gate. */
  decision: string | null;
  /** How long the hook held the message. */
  waitedMs: number;
  snapshotMs: number | null;
  createdAt: number;
}

type Raw = Record<string, unknown>;

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

function toCheckpoint(row: Raw): CheckpointRow {
  const headSha = str(row.head_sha);
  const headBranch = str(row.head_branch);
  const isGit = row.is_git === 1;
  return {
    seq: Number(row.rowid),
    id: String(row.id),
    threadId: String(row.thread_id),
    projectId: str(row.project_id),
    environmentId: String(row.environment_id),
    hostId: String(row.host_id),
    workspace: String(row.workspace),
    kind: String(row.kind) as CheckpointKind,
    label: str(row.label),
    attempt: (str(row.attempt) as DispatchAttempt | null) ?? null,
    status: String(row.status) as CheckpointStatus,
    late: row.late === 1,
    eventMark: num(row.event_mark),
    messageExcerpt: str(row.message_excerpt),
    commit: str(row.commit_sha),
    tree: str(row.tree_sha),
    deduped: row.deduped === 1,
    head: isGit ? { sha: headSha, branch: headBranch } : null,
    baseline: row.baseline === 1,
    stats:
      num(row.files_changed) === null
        ? null
        : { files: num(row.files_changed)!, insertions: num(row.insertions) ?? 0, deletions: num(row.deletions) ?? 0 },
    changes: json<FileChange[]>(row.changes_json, []),
    changesTruncated: row.changes_truncated === 1,
    skipped: json<SkippedFile[]>(row.skipped_json, []),
    skippedCount: num(row.skipped_count) ?? 0,
    fileCount: num(row.file_count),
    durationMs: num(row.duration_ms),
    error: str(row.error),
    createdAt: Number(row.created_at),
    completedAt: num(row.completed_at),
    effects: row.effects_json === null || row.effects_json === undefined ? null : json<StoredEffect[]>(row.effects_json, []),
  };
}

function toGateWait(row: Raw): GateWaitRow {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    environmentId: str(row.environment_id),
    kind: String(row.kind) as GateWaitKind,
    checkpointId: str(row.checkpoint_id),
    rowIds: json<string[]>(row.row_ids_json, []),
    createdAt: Number(row.created_at),
    recheckAt: num(row.recheck_at),
    reattemptAt: num(row.reattempt_at),
    dispatchedAt: num(row.dispatched_at),
    closedAt: num(row.closed_at),
    closedBy: str(row.closed_by),
  };
}

function toRestore(row: Raw): RestoreRow {
  return {
    seq: Number(row.rowid),
    id: String(row.id),
    threadId: String(row.thread_id),
    environmentId: String(row.environment_id),
    hostId: String(row.host_id),
    workspace: String(row.workspace),
    kind: String(row.kind) as RestoreKind,
    targetCheckpointId: String(row.target_checkpoint_id),
    preRestoreCheckpointId: str(row.pre_restore_checkpoint_id),
    status: String(row.status) as RestoreStatus,
    eventMark: num(row.event_mark),
    summary: json<RestoreSummary | null>(row.summary_json, null),
    error: str(row.error),
    undoneBy: str(row.undone_by),
    createdAt: Number(row.created_at),
  };
}

function toFork(row: Raw): ForkRow {
  return {
    id: String(row.id),
    sourceThreadId: String(row.source_thread_id),
    checkpointId: String(row.checkpoint_id),
    anchorSeq: num(row.anchor_seq),
    forkThreadId: str(row.fork_thread_id),
    status: String(row.status) as ForkStatus,
    step: str(row.step),
    error: str(row.error),
    prompt: str(row.prompt),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export interface NewCheckpoint {
  id: string;
  threadId: string;
  projectId: string | null;
  environmentId: string;
  hostId: string;
  workspace: string;
  kind: CheckpointKind;
  label: string | null;
  attempt: DispatchAttempt | null;
  eventMark: number | null;
  messageExcerpt: string | null;
  createdAt: number;
}

export interface CheckpointResult {
  commit: string;
  tree: string;
  deduped: boolean;
  head: HeadInfo | null;
  baseline: boolean;
  stats: ChangeStats;
  changes: FileChange[];
  changesTruncated: boolean;
  skipped: SkippedFile[];
  skippedCount: number;
  fileCount: number;
  durationMs: number;
}

const GATE_SAMPLE_LIMIT = 1_000;

export class RewindStore {
  constructor(private readonly db: Database.Database) {}

  insertCheckpoint(input: NewCheckpoint): CheckpointRow {
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, thread_id, project_id, environment_id, host_id, workspace, kind, label, attempt, status, event_mark, message_excerpt, created_at)
         VALUES (@id, @threadId, @projectId, @environmentId, @hostId, @workspace, @kind, @label, @attempt, 'pending', @eventMark, @messageExcerpt, @createdAt)`,
      )
      .run(input);
    return this.getCheckpoint(input.id)!;
  }

  completeCheckpoint(id: string, result: CheckpointResult, options: { late: boolean; completedAt: number }): CheckpointRow | null {
    this.db
      .prepare(
        `UPDATE checkpoints SET status = 'ok', late = @late, commit_sha = @commit, tree_sha = @tree, deduped = @deduped,
           head_sha = @headSha, head_branch = @headBranch, is_git = @isGit, baseline = @baseline,
           files_changed = @files, insertions = @insertions, deletions = @deletions,
           changes_json = @changes, changes_truncated = @changesTruncated, skipped_json = @skipped, skipped_count = @skippedCount,
           file_count = @fileCount, duration_ms = @durationMs, error = NULL, completed_at = @completedAt
         WHERE id = @id`,
      )
      .run({
        id,
        late: options.late ? 1 : 0,
        commit: result.commit,
        tree: result.tree,
        deduped: result.deduped ? 1 : 0,
        headSha: result.head?.sha ?? null,
        headBranch: result.head?.branch ?? null,
        isGit: result.head === null ? 0 : 1,
        baseline: result.baseline ? 1 : 0,
        files: result.stats.files,
        insertions: result.stats.insertions,
        deletions: result.stats.deletions,
        changes: JSON.stringify(result.changes),
        changesTruncated: result.changesTruncated ? 1 : 0,
        skipped: JSON.stringify(result.skipped),
        skippedCount: result.skippedCount,
        fileCount: result.fileCount,
        durationMs: Math.round(result.durationMs),
        completedAt: options.completedAt,
      });
    return this.getCheckpoint(id);
  }

  failCheckpoint(id: string, status: "failed" | "unsupported", error: string, options: { late: boolean; completedAt: number; durationMs: number | null }): CheckpointRow | null {
    this.db
      .prepare(
        `UPDATE checkpoints SET status = @status, error = @error, late = @late, completed_at = @completedAt, duration_ms = @durationMs WHERE id = @id`,
      )
      .run({ id, status, error: error.slice(0, 2_000), late: options.late ? 1 : 0, completedAt: options.completedAt, durationMs: options.durationMs });
    return this.getCheckpoint(id);
  }

  markLate(id: string): void {
    this.db.prepare(`UPDATE checkpoints SET late = 1 WHERE id = ?`).run(id);
  }

  getCheckpoint(id: string): CheckpointRow | null {
    const row = this.db.prepare(`SELECT rowid, * FROM checkpoints WHERE id = ?`).get(id) as Raw | undefined;
    return row === undefined ? null : toCheckpoint(row);
  }

  /** A thread's checkpoints in creation order (oldest first). */
  listCheckpoints(threadId: string, limit = 10_000): CheckpointRow[] {
    const rows = this.db
      .prepare(`SELECT rowid, * FROM (SELECT rowid, * FROM checkpoints WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rowid ASC`)
      .all(threadId, limit) as Raw[];
    return rows.map(toCheckpoint);
  }

  countCheckpoints(threadId: string): { total: number; pending: number; lastAt: number | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, MAX(created_at) AS lastAt
         FROM checkpoints WHERE thread_id = ? AND status IN ('ok', 'pending')`,
      )
      .get(threadId) as Raw;
    return { total: Number(row.total ?? 0), pending: Number(row.pending ?? 0), lastAt: num(row.lastAt) };
  }

  latestOkCheckpoint(threadId: string): CheckpointRow | null {
    const row = this.db
      .prepare(`SELECT rowid, * FROM checkpoints WHERE thread_id = ? AND status = 'ok' ORDER BY rowid DESC LIMIT 1`)
      .get(threadId) as Raw | undefined;
    return row === undefined ? null : toCheckpoint(row);
  }

  hasCheckpoints(threadId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM checkpoints WHERE thread_id = ? LIMIT 1`).get(threadId) !== undefined;
  }

  checkpointsForWorkspace(hostId: string, workspace: string): Array<{ id: string; threadId: string }> {
    return (this.db.prepare(`SELECT id, thread_id FROM checkpoints WHERE host_id = ? AND workspace = ?`).all(hostId, workspace) as Raw[]).map(
      (row) => ({ id: String(row.id), threadId: String(row.thread_id) }),
    );
  }

  /** Distinct (host, workspace) pairs that still have checkpoints. */
  workspaces(): Array<{ hostId: string; workspace: string }> {
    return (this.db.prepare(`SELECT DISTINCT host_id, workspace FROM checkpoints`).all() as Raw[]).map((row) => ({
      hostId: String(row.host_id),
      workspace: String(row.workspace),
    }));
  }

  threadIds(): string[] {
    return (this.db.prepare(`SELECT DISTINCT thread_id FROM checkpoints`).all() as Raw[]).map((row) => String(row.thread_id));
  }

  /** Delete checkpoint rows; returns what was deleted for ref cleanup. */
  deleteCheckpoints(ids: readonly string[]): Array<{ id: string; hostId: string; workspace: string }> {
    const deleted: Array<{ id: string; hostId: string; workspace: string }> = [];
    const select = this.db.prepare(`SELECT id, host_id, workspace FROM checkpoints WHERE id = ?`);
    const remove = this.db.prepare(`DELETE FROM checkpoints WHERE id = ?`);
    this.db.transaction(() => {
      for (const id of ids) {
        const row = select.get(id) as Raw | undefined;
        if (row === undefined) continue;
        remove.run(id);
        deleted.push({ id, hostId: String(row.host_id), workspace: String(row.workspace) });
      }
    })();
    return deleted;
  }

  deleteThread(threadId: string): Array<{ id: string; hostId: string; workspace: string }> {
    const ids = (this.db.prepare(`SELECT id FROM checkpoints WHERE thread_id = ?`).all(threadId) as Raw[]).map((row) => String(row.id));
    const deleted = this.deleteCheckpoints(ids);
    this.db.prepare(`DELETE FROM restores WHERE thread_id = ?`).run(threadId);
    this.db.prepare(`DELETE FROM notes WHERE thread_id = ?`).run(threadId);
    return deleted;
  }

  /** Pending rows whose snapshot never reported back (server restart). */
  failStalePending(olderThan: number, now: number): number {
    return this.db
      .prepare(`UPDATE checkpoints SET status = 'failed', error = 'The snapshot was interrupted.', completed_at = ? WHERE status = 'pending' AND created_at < ?`)
      .run(now, olderThan).changes;
  }

  // ------------------------------------------------------------- restores

  insertRestore(row: Omit<RestoreRow, "seq" | "undoneBy">): RestoreRow {
    this.db
      .prepare(
        `INSERT INTO restores (id, thread_id, environment_id, host_id, workspace, kind, target_checkpoint_id, pre_restore_checkpoint_id, status, event_mark, summary_json, error, created_at)
         VALUES (@id, @threadId, @environmentId, @hostId, @workspace, @kind, @targetCheckpointId, @preRestoreCheckpointId, @status, @eventMark, @summary, @error, @createdAt)`,
      )
      .run({ ...row, summary: row.summary === null ? null : JSON.stringify(row.summary) });
    return this.getRestore(row.id)!;
  }

  markUndone(restoreId: string, undoneBy: string): void {
    this.db.prepare(`UPDATE restores SET undone_by = ? WHERE id = ?`).run(undoneBy, restoreId);
  }

  getRestore(id: string): RestoreRow | null {
    const row = this.db.prepare(`SELECT rowid, * FROM restores WHERE id = ?`).get(id) as Raw | undefined;
    return row === undefined ? null : toRestore(row);
  }

  listRestores(threadId: string, limit = 200): RestoreRow[] {
    return (
      this.db
        .prepare(`SELECT rowid, * FROM (SELECT rowid, * FROM restores WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rowid ASC`)
        .all(threadId, limit) as Raw[]
    ).map(toRestore);
  }

  /**
   * The newest restore in the workspace (any thread) that changed files: the
   * undo target. A failure with an undo point stopped part way and counts; one
   * without stopped before any file changed and does not.
   */
  latestRestoreInWorkspace(hostId: string, workspace: string): RestoreRow | null {
    const row = this.db
      .prepare(
        `SELECT rowid, * FROM restores WHERE host_id = ? AND workspace = ? AND (status != 'failed' OR pre_restore_checkpoint_id IS NOT NULL) ORDER BY rowid DESC LIMIT 1`,
      )
      .get(hostId, workspace) as Raw | undefined;
    return row === undefined ? null : toRestore(row);
  }

  /** Checkpoint ids restores still point at (kept by retention for undo). */
  restoreReferencedIds(threadId: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT target_checkpoint_id, pre_restore_checkpoint_id FROM restores WHERE thread_id = ?`)
      .all(threadId) as Raw[];
    const ids = new Set<string>();
    for (const row of rows) {
      if (typeof row.target_checkpoint_id === "string") ids.add(row.target_checkpoint_id);
      if (typeof row.pre_restore_checkpoint_id === "string") ids.add(row.pre_restore_checkpoint_id);
    }
    return ids;
  }

  // ---------------------------------------------------------------- forks

  insertFork(row: ForkRow): ForkRow {
    this.db
      .prepare(
        `INSERT INTO forks (id, source_thread_id, checkpoint_id, anchor_seq, fork_thread_id, status, step, error, prompt, created_at, updated_at)
         VALUES (@id, @sourceThreadId, @checkpointId, @anchorSeq, @forkThreadId, @status, @step, @error, @prompt, @createdAt, @updatedAt)`,
      )
      .run(row);
    return this.getFork(row.id)!;
  }

  updateFork(id: string, patch: Partial<Pick<ForkRow, "forkThreadId" | "status" | "step" | "error">>, now: number): ForkRow | null {
    const current = this.getFork(id);
    if (current === null) return null;
    const next = { ...current, ...patch, updatedAt: now };
    this.db
      .prepare(`UPDATE forks SET fork_thread_id = @forkThreadId, status = @status, step = @step, error = @error, updated_at = @updatedAt WHERE id = @id`)
      .run(next);
    return this.getFork(id);
  }

  getFork(id: string): ForkRow | null {
    const row = this.db.prepare(`SELECT * FROM forks WHERE id = ?`).get(id) as Raw | undefined;
    return row === undefined ? null : toFork(row);
  }

  failInterruptedForks(now: number): number {
    return this.db
      .prepare(`UPDATE forks SET status = 'failed', error = 'Interrupted by a server restart.', updated_at = ? WHERE status = 'running'`)
      .run(now).changes;
  }

  // ---------------------------------------------------------- gate stats

  recordGate(sample: {
    threadId: string | null;
    checkpointId: string | null;
    outcome: string;
    decision: "proceed" | "wait";
    waitedMs: number;
    snapshotMs: number | null;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO gate_samples (thread_id, checkpoint_id, outcome, decision, waited_ms, snapshot_ms, created_at) VALUES (@threadId, @checkpointId, @outcome, @decision, @waitedMs, @snapshotMs, @createdAt)`,
      )
      .run({ ...sample, waitedMs: Math.round(sample.waitedMs), snapshotMs: sample.snapshotMs === null ? null : Math.round(sample.snapshotMs) });
    this.db.prepare(`DELETE FROM gate_samples WHERE id <= (SELECT MAX(id) FROM gate_samples) - ?`).run(GATE_SAMPLE_LIMIT);
  }

  setGateSnapshotMs(checkpointId: string, snapshotMs: number): void {
    this.db.prepare(`UPDATE gate_samples SET snapshot_ms = ? WHERE checkpoint_id = ?`).run(Math.round(snapshotMs), checkpointId);
  }

  gateSamples(limit = GATE_SAMPLE_LIMIT): GateSample[] {
    return (this.db.prepare(`SELECT checkpoint_id, outcome, decision, waited_ms, snapshot_ms, created_at FROM gate_samples ORDER BY id DESC LIMIT ?`).all(limit) as Raw[]).map(
      (row) => ({
        checkpointId: str(row.checkpoint_id),
        outcome: String(row.outcome),
        decision: str(row.decision),
        waitedMs: Number(row.waited_ms),
        snapshotMs: num(row.snapshot_ms),
        createdAt: Number(row.created_at),
      }),
    );
  }

  // ------------------------------------------------------------ gate waits

  insertGateWait(row: Omit<GateWaitRow, "recheckAt" | "reattemptAt" | "dispatchedAt" | "closedAt" | "closedBy">): GateWaitRow {
    this.db
      .prepare(
        `INSERT INTO gate_waits (id, thread_id, environment_id, kind, checkpoint_id, row_ids_json, created_at)
         VALUES (@id, @threadId, @environmentId, @kind, @checkpointId, @rowIds, @createdAt)`,
      )
      .run({ ...row, rowIds: JSON.stringify(row.rowIds) });
    this.db.prepare(`DELETE FROM gate_waits WHERE rowid <= (SELECT MAX(rowid) FROM gate_waits) - ?`).run(GATE_SAMPLE_LIMIT);
    return this.getGateWait(row.id)!;
  }

  getGateWait(id: string): GateWaitRow | null {
    const row = this.db.prepare(`SELECT * FROM gate_waits WHERE id = ?`).get(id) as Raw | undefined;
    return row === undefined ? null : toGateWait(row);
  }

  updateGateWait(
    id: string,
    fields: Partial<Pick<GateWaitRow, "checkpointId" | "rowIds" | "recheckAt" | "reattemptAt" | "dispatchedAt" | "closedAt" | "closedBy">>,
  ): void {
    const columns: Record<string, string> = {
      checkpointId: "checkpoint_id",
      rowIds: "row_ids_json",
      recheckAt: "recheck_at",
      reattemptAt: "reattempt_at",
      dispatchedAt: "dispatched_at",
      closedAt: "closed_at",
      closedBy: "closed_by",
    };
    const entries = Object.entries(fields).filter(([key]) => columns[key] !== undefined);
    if (entries.length === 0) return;
    const values = Object.fromEntries(entries.map(([key, value]) => [key, key === "rowIds" ? JSON.stringify(value) : value]));
    this.db.prepare(`UPDATE gate_waits SET ${entries.map(([key]) => `${columns[key]} = @${key}`).join(", ")} WHERE id = @id`).run({ ...values, id });
  }

  /** Waits not yet closed (still queued, or released but not dispatched yet). */
  openGateWaits(): GateWaitRow[] {
    return (this.db.prepare(`SELECT * FROM gate_waits WHERE closed_at IS NULL ORDER BY rowid ASC`).all() as Raw[]).map(toGateWait);
  }

  gateWaits(limit = GATE_SAMPLE_LIMIT): GateWaitRow[] {
    return (this.db.prepare(`SELECT * FROM gate_waits ORDER BY rowid DESC LIMIT ?`).all(limit) as Raw[]).map(toGateWait);
  }

  // ----------------------------------------------------------------- notes

  setNote(note: NoteRow): void {
    this.db
      .prepare(
        `INSERT INTO notes (thread_id, restore_id, text, created_at) VALUES (@threadId, @restoreId, @text, @createdAt)
         ON CONFLICT(thread_id) DO UPDATE SET restore_id = excluded.restore_id, text = excluded.text, created_at = excluded.created_at`,
      )
      .run(note);
  }

  getNote(threadId: string): NoteRow | null {
    const row = this.db.prepare(`SELECT * FROM notes WHERE thread_id = ?`).get(threadId) as Raw | undefined;
    return row === undefined
      ? null
      : { threadId: String(row.thread_id), restoreId: str(row.restore_id), text: String(row.text), createdAt: Number(row.created_at) };
  }

  deleteNote(threadId: string): boolean {
    return this.db.prepare(`DELETE FROM notes WHERE thread_id = ?`).run(threadId).changes > 0;
  }

  // --------------------------------------------------------------- effects

  setEffects(checkpointId: string, effects: readonly StoredEffect[]): void {
    this.db.prepare(`UPDATE checkpoints SET effects_json = ? WHERE id = ?`).run(JSON.stringify(effects), checkpointId);
  }
}
