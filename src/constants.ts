// Values shared by the server, the host entry, the CLI, and the app.

export const PLUGIN_ID = "rewind";

/** Realtime channel: `{ threadId }` whenever a thread's checkpoints change. */
export const CHANGED_CHANNEL = "rewind.changed";

/** The `threadPanelAction` id the message action and header control open. */
export const PANEL_ACTION_ID = "checkpoints";

/**
 * The `message.dispatch` hook runs under a server-wide lock, so it holds a
 * message only briefly for its checkpoint (`gateHoldMs`, at most this). A
 * slower snapshot queues the message instead ("wait") and releases it with
 * `recheck` when the checkpoint is saved.
 */
export const MAX_GATE_HOLD_MS = 2_000;
export const DEFAULT_GATE_HOLD_MS = 200;
/** The hook always answers within this, whatever happens (its box is 10 s). */
export const GATE_HARD_LIMIT_MS = MAX_GATE_HOLD_MS + 1_500;
/** Longest a message stays queued behind its checkpoint; core re-attempts it then. */
export const GATE_WAIT_CAP_MS = 30 * 1000;
/** Queued-card reasons. Every Rewind reason starts with WAIT_REASON_PREFIX. */
export const WAIT_REASON_PREFIX = "Rewind:";
export const WAIT_REASON_SNAPSHOT = "Rewind: saving a checkpoint…";
export const WAIT_REASON_RESTORE = "Rewind: restoring files…";

/** A workspace over either cap is marked unsupported instead of snapshotted. */
export const WORKSPACE_MAX_FILES = 100_000;
export const WORKSPACE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * bb's per-chat copies in the workspace (`.bb/chats/<threadId>/`). bb stays
 * the canonical chat store, so Rewind never captures, diffs, or restores
 * them. The rest of `.bb/` can be user content and is captured as usual.
 */
export const BB_CHAT_DIR = ".bb/chats";
/**
 * Looking up where bb keeps a thread's own storage (to leave it alone when it
 * is inside the workspace) runs while the gate holds a message: keep it brief.
 */
export const STORAGE_LOOKUP_MS = 250;
export const STORAGE_RETRY_MS = 60 * 1000;

/** How long an unsupported verdict holds before a snapshot re-measures. */
export const UNSUPPORTED_RECHECK_MS = 60 * 60 * 1000;

/** Host call timeouts. The gate never waits for these; it holds briefly, then queues. */
export const SNAPSHOT_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Above the host's own git timeouts, so the server never gives up first. Also
 * the safety cap for messages queued behind a restore.
 */
export const RESTORE_TIMEOUT_MS = 20 * 60 * 1000;
export const DIFF_TIMEOUT_MS = 2 * 60 * 1000;
export const GC_TIMEOUT_MS = 20 * 60 * 1000;

/** Output bounds. Host results are capped at 8 MiB by the daemon. */
export const MAX_PATCH_BYTES_PER_FILE = 256 * 1024;
export const MAX_PATCH_BYTES_TOTAL = 2 * 1024 * 1024;
export const MAX_LISTED_CHANGES = 500;
export const MAX_LISTED_SKIPPED = 100;
export const MAX_STORED_CHANGES = 200;

/** Message excerpts stored with checkpoints and shown in lists. */
export const EXCERPT_CHARS = 160;

/** git's well-known empty tree. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A snapshot that never reports back (server restart) is failed after this. */
export const PENDING_STALE_MS = 15 * 60 * 1000;

/** How long `fork` waits for the new worktree before giving up. */
export const FORK_ENVIRONMENT_WAIT_MS = 10 * 60 * 1000;
