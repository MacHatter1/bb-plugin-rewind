---
name: rewind
description: Checkpoint, inspect, and restore this thread's workspace files with Rewind (`bb rewind`, `rewind_checkpoint`, `rewind_list`). Use before a risky or sweeping file operation, when the user asks to undo an earlier turn's file changes, to see what a turn changed, or to try a different approach from an earlier point with the files as they were.
---

# Rewind

Rewind snapshots this thread's workspace automatically before every message
is sent and after every turn ends. Snapshots live in Rewind's own store on the
machine that holds the workspace; nothing is written to the repository's
`.git`, index, branches, or stash.

## When to checkpoint

The automatic checkpoints cover each turn. Add one yourself, mid-turn, right
before an operation that is hard to reverse:

- a codemod, search-and-replace, or formatter run across many files;
- deleting or moving directories;
- running a script or generator that rewrites files.

Call the `rewind_checkpoint` tool with a short label saying what comes next
(`{"label": "before renaming the api module"}`), or run
`bb rewind checkpoint --label "…"`. Mention the checkpoint id to the user.

## Restoring is the user's decision

Never restore, undo, or fork on your own initiative. A restore also refuses
while any thread in the workspace is running, and that includes you during
your turn, so you cannot restore your own workspace mid-turn. When the user
asks to go back:

1. `bb rewind list` — find the checkpoint (turns are numbered; each shows the
   message excerpt, time, and files changed).
2. `bb rewind restore <checkpoint> --dry-run` — show the user what a restore
   would write, create, delete, and leave alone.
3. Give them the checkpoint id. They restore it from the Checkpoints panel
   ("Rewind to here" on a message opens it), or with
   `bb rewind restore <checkpoint> --yes --thread <thread-id>` in a terminal
   once your turn has ended. `bb rewind undo --yes` reverses the last restore.
4. If they want to redo a turn differently, point them to **Restore files and
   edit this message** in the preview (or `--edit-message` on the restore): it
   restores the files and replaces that message, so bb drops the later turns
   too and the conversation matches the files.

## After a restore

If the files were restored but the conversation was not rewound, your earlier
turns still describe edits that are no longer on disk. The user's next
message may start with Rewind's note, such as "Files were restored to before
message 3; turns 3–5 were undone. Re-read files before editing." When you see
it, re-read the files you are about to change instead of relying on what you
wrote earlier.

Restoring brings back files only. If a turn you are about to have undone ran
`git push`, a publish, a migration, a deploy, `docker`/`kubectl`, a global
install, wrote outside the workspace, or sent a mutating HTTP request, the
preview lists it: tell the user those effects stay.

## Commands

| Command | Does |
| --- | --- |
| `bb rewind list [--limit N]` | Checkpoints of the thread, newest turn first, plus restores. |
| `bb rewind show <checkpoint>` | What a checkpoint captured, changed, and skipped. |
| `bb rewind diff <checkpoint> [--stat] [--to current\|<checkpoint>] [--path p]` | What that turn changed, or what changed since it. Patches are capped. |
| `bb rewind restore <checkpoint> --dry-run` / `--yes` | Preview, then restore the files. Lists commands whose effects outside the workspace stay. |
| `bb rewind restore <before-checkpoint> --yes --edit-message "…"` | Restore the files, then replace the message that checkpoint preceded (bb drops every later turn). |
| `bb rewind undo --dry-run` / `--yes` | Undo the latest restore. |
| `bb rewind checkpoint [--label "…"]` | Checkpoint now. |
| `bb rewind fork <checkpoint> [--prompt "…" \| --prompt-file f] [--title "…"]` | New thread in a new worktree, conversation cut at that point, files as they were. |
| `bb rewind status` | Settings, message-gate latency, and this thread's state. |
| `bb rewind compact [--dry-run] [--quick] [--thread <id>]` | Aggressively recompress storage on connected machines without deleting checkpoints. `--thread` selects stores holding that thread's checkpoints, including vanished workspaces; `--quick` only packs loose objects and combines packs. |
| `bb rewind pool [--dry-run] [--thread <id>]` | Opt in to shared-object storage. Copy and verify before linking stores and removing local duplicates; rerun to resume an interrupted migration or add new stores. |
| `bb rewind pool --gc [--dry-run]` | Coordinate collection across every pool member; cannot be limited to one thread. Also runs during daily retention. |
| `bb rewind prune [--dry-run]` | Apply retention now. Checkpoints past the per-thread cap are also removed as new ones are saved. `--thread <id> --yes` deletes one thread's checkpoints. |

Thread-scoped commands default to the calling thread; `compact` defaults to
all stores. Outside a thread pass
`--thread <thread-id>`. Every command accepts `--json`. Checkpoint ids can be
shortened to any unique prefix.

For storage pressure, preview with `bb rewind compact --dry-run`, then use
`bb rewind compact` to aggressively recompress existing packs while preserving
all checkpoints and unreferenced objects. `--deep` explicitly selects this
default; `--quick` skips aggressive recompression. Temporary space is needed
for replacement packs, and compressed
media may shrink very little. `prune` also applies retention and can delete
history; compaction does not.

`pool --dry-run` measures without writes. Pool migration preserves checkpoint
refs and all stored objects, including unreachable objects; new snapshots keep
writing locally. Shared-pool migration/GC pause Rewind operations on that host,
so run them when other threads can wait. GC inventories every member and pins
Undo, imports, comparisons, indexes and cached roots as well as checkpoints.
It retains retired roots for two hours and refuses incomplete migrations or
uncertain membership. Never run ordinary Git GC/prune on `object-pool/git`,
delete the pool, or move a member without its Rewind-owned pool. Keep both in
backups. A crash lock must not be cleared until its worker and any orphaned Git
processes are confirmed stopped; age alone is not evidence. A handled failure
needs only a rerun of `pool`.

## Safety behaviour to rely on

- A restore takes a pre-restore checkpoint first and aborts if it cannot, so
  every restore can be undone, including one that stops part way (the error
  says "did not finish"; `bb rewind undo --yes` puts every file back). A lost
  transport response may leave the outcome uncertain: Undo keeps its identity
  across reload, refuses to skip to an older restore, and resolves the same
  pre-restore ref after reconnecting. Missing and unavailable refs are distinct.
- A restore never touches ignored files (`node_modules`, an ignored `.env`),
  `.git`, nested repositories, or files over the size cap (default 10 MB);
  those are listed as "left alone" or "skipped". bb's chat copies
  (`.bb/chats/`) are never captured or restored, so they never appear.
- It deletes only non-ignored files the checkpoint does not contain, and
  verifies afterwards that the files match the checkpoint. Newly ignored
  absent files are not recreated; nested-repository transitions and lowered
  size caps also protect older checkpoints. Oversized composed ignore sources
  fail preparation explicitly rather than silently dropping rules.
- It refuses while this thread, or any other thread in any environment on the
  same host sharing the canonical workspace directory, is running. Aliases do
  not bypass the gate; expired waits remain queued until the restore ends. Rewind restores files only: if git HEAD moved (you committed), the
  preview warns and commits stay as they are.
- Checkpointing holds a message at most a fraction of a second; a slower
  checkpoint queues it ("Rewind: saving a checkpoint…") until saved, 30 s at
  most. While a restore writes files, messages to this workspace queue until
  it ends.
