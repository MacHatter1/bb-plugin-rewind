# Rewind design

Rewind lets a user undo an agent's file changes turn by turn, on every
provider. bb's checkpoint forks only fork the conversation; Rewind snapshots
each thread's workspace at every turn boundary, shows what each turn changed,
restores files to before any message (or after any reply), undoes restores,
and forks a thread into a new worktree with the files as they were.

This document records how it works, what it measured live, and where it
deviates from the brief it was built from (SDK 0.5.9, bb 0.43.4).

## Components

```
server.ts ──────────────────────────────────────────────────────────────┐
  message.dispatch hook  → RewindService.onDispatch (before-turn)       │
  thread.active          → onThreadActive (a new thread's baseline)     │
  thread.idle / .failed  → onTurnEnded (after-turn)                     │
  thread.deleted         → onThreadDeleted                              │
  bb.rpc (app, `bb plugin rpc call rewind …`), bb rewind CLI, agent     │
  tools, daily retention schedule                                       │
        │  bb.hosts.experimental_client(hostContract).call(…, {hostId}) │
        ▼                                                               │
host.ts (runs on the thread's machine) ─ src/host/*                     │
  one shadow git repository per workspace, all git work serialized     │
  per workspace                                                         │
app.tsx ─ "Rewind to here", Checkpoints panel, header count, palette ───┘
```

- `src/service.ts` holds the server logic and is driven directly by tests.
- `src/host/shadow.ts` is the git engine; `src/host/plan.ts` decides what a
  restore may touch (pure); `src/host/user-repo.ts` asks the user's
  repository read-only questions.
- `src/mapping.ts`, `src/retention.ts`, `src/turns.ts`, and
  `src/settings.ts` are pure and unit-tested.
- Metadata lives in plugin SQLite (`src/store.ts`): checkpoints (thread,
  environment, host, workspace, kind, label, attempt, event mark, message
  excerpt, commit/tree, HEAD sha and branch, stats, per-file changes,
  skipped files, duration, `late`, status, error), restores (for Undo), fork
  jobs, and the last 1,000 gate latency samples.

## The shadow repository

Each workspace gets `<host dataDir>/shadows/<sha256(path)>/git`, driven with
`--git-dir=<shadow> --work-tree=<workspace>`. Nothing is written into the
workspace (except by a restore) or into the user's `.git`, and it works the
same in non-git workspaces.

- **Pinned format.** `git init --bare --template=` with
  `init.defaultObjectFormat=sha1` and `init.defaultRefFormat=files`, so a
  user's init templates, hooks, or sha256/reftable defaults never shape it.
- **Exact bytes.** `info/attributes` sets `* -text -filter -ident
  -working-tree-encoding`: no line-ending conversion, no clean/smudge
  filters (git-lfs), no `$Id$` expansion. Every command also passes
  `-c core.autocrlf=false -c core.fsmonitor=false -c gc.auto=0 …` and the
  case sensitivity probed from the workspace itself (without writing to it).
- **Ignore rules match the user's git.** The work tree's `.gitignore` files
  apply natively. Everything else the user's git would apply is copied into
  the shadow's `info/exclude` on every snapshot: the repository's
  `info/exclude`, the effective `core.excludesFile`, and, when the workspace
  is a subdirectory of a repository, the `.gitignore` files above it,
  re-based onto the workspace (`src/host/ignore.ts`). The shadow's own
  `core.excludesFile` points at an empty file so the global file is not
  applied twice with the wrong base.
- **Tracked-but-ignored files** (force-added in the user's repository) are
  captured like any tracked file (`git ls-files -c -i --exclude-standard`,
  read-only, cached for a minute). When ignore rules change, files that
  became ignored are dropped from the shadow index so they are neither
  captured nor touched.
- **bb's chat storage is not the user's.** bb keeps an automatically
  updated copy of each chat in the workspace (`.bb/chats/<threadId>/`:
  `thread.json`, `history/…`), and a thread's own storage can be configured
  inside a workspace too (`threads.storageLocation`). The host never
  captures, diffs, or restores either: `.bb/chats/` is excluded in every
  workspace, and the server passes the thread's storage directory as
  `excludePaths` (the host keeps those inside the workspace, remembered in
  the shadow's `state.json`). The rest of `.bb/` (`.bb/plugins.json`) is user
  content and captured as usual. Entries Rewind 0.1 captured there are
  dropped from the shadow index on the next snapshot; a restore of an older
  checkpoint that still holds them leaves the current copies exactly as they
  are (neither written nor deleted, and not listed in the plan), and lists
  and stats of old checkpoints leave them out.
- **Persistent index.** A snapshot is `git status --porcelain=v2 -z`, a stat
  of each changed path, `git update-index --add --remove --replace -z
  --stdin` for exactly those paths, `git write-tree`, `git commit-tree`,
  and one `update-ref --stdin` transaction. Only changed files are
  re-hashed.
- **Skipped, never touched.** Files over `maxFileSizeMB` (default 10) are
  never passed to git. Nested repositories (including ones without commits,
  which make `git add` abort) and unreadable files (checked with `access`
  before git sees them) are skipped and reported. A captured file that grows
  past the cap, becomes unreadable, or turns into a directory is removed
  from the index, so no checkpoint claims its old content and no restore
  overwrites what is there now.
- **Unsupported workspaces.** More than 100,000 files, or more than 2 GiB
  of new or changed files in one snapshot (on the first snapshot, the whole
  workspace), marks the workspace unsupported for an hour (`status` is
  streamed and killed at the cap, so a huge tree is never fully walked or
  hashed). Messages are not delayed; the panel says why.
- **One ref per checkpoint.** `refs/rewind/<checkpointId>` points at a
  parentless commit. Parentless commits let retention free a checkpoint's
  objects by deleting its ref. An unchanged tree reuses the previous commit
  (dedup: no new objects, just a ref). The shadow is self-contained: no
  alternates into the user's object store, so checkpoints survive the user's
  gc, rebases, and deleted branches.
- **Serialized.** All git work on a workspace runs under a per-shadow mutex
  in the host worker. Stale `index.lock` files from killed processes are
  removed after a minute.
- **Paths are bytes.** Host code keeps paths as latin1 "byte strings", so
  non-UTF-8 names round-trip through status, update-index, and lstat.

## When checkpoints are taken

| Moment | How | Kind |
| --- | --- | --- |
| Before a message is sent | `message.dispatch` hook, when the thread has a ready environment | before-turn |
| A brand-new thread's first message | its environment does not exist at dispatch, so on `thread.active`, first turn only | before-turn, label "Thread start", mark 0 |
| A turn ends | `thread.idle` and `thread.failed` | after-turn |
| On demand | panel button, `bb rewind checkpoint`, `rewind_checkpoint` tool, palette | manual |
| Before every restore | inside the host restore call, atomically | pre-restore |

The gate is the delicate part. BB's hook is fail-closed with a 10 s decision
box and runs under a **server-wide lock**, so a slow handler delays every
dispatch in bb, not only its own thread. The hook can also answer `wait`,
which queues the message as a row with a card showing the reason, and
`bb.experimental_hooks.recheck` asks core to re-attempt queued rows. Rewind
uses both, so it holds the lock only briefly:

- **Hold, then queue.** The gate starts the snapshot and holds the message at
  most `gateHoldMs` (default 200; live p95 was 147 ms, so most messages are
  never queued). If the snapshot is not done by then, it answers
  `{ action: "wait", reason: "Rewind: saving a checkpoint…", sendAt: now + 30 s }`
  and lets the snapshot finish. When it does, Rewind calls `recheck`; the
  re-attempt finds the finished checkpoint (exact, not late) and proceeds.
- **Queued once, for one checkpoint.** A re-attempt of a row Rewind queued
  is decided at once, without holding the lock again. Once its checkpoint is
  saved (or failed) it proceeds. While the checkpoint is still being saved,
  it stays in the same wait with the same 30 s deadline, and past the
  deadline it proceeds, with the checkpoint finishing behind it and marked
  late only if it really finished after the message went out. Rows are
  recognized by their `waitingOn` (Rewind's plugin id, or its reason appended
  to another plugin's wait) and by the row ids `message.queued` reports;
  both survive a restart.
- **Send now** skips the hook by design. `message.dispatched` reports it, and
  a checkpoint still running then is marked late.
- **Fail-open.** A failed snapshot rechecks at once; `sendAt` releases the
  message after 30 s whatever happens; on load the plugin fails snapshots a
  previous load left pending and calls `recheck`, so rows still waiting on
  Rewind re-attempt and proceed. When the plugin is disabled, bb's orphan
  sweep releases the rows it holds; across a reload a row stays queued
  until the new load's recheck (both seen live, see Measured live).
- does not hold a steer (`join-turn`): the agent is already writing, so
  waiting would not make that mid-turn snapshot cleaner;
- skips a `start-turn` submitted while the thread is busy: it is queued and
  the drain re-attempt (which runs the hook again) snapshots;
- reuses its checkpoint when the hook asks again about the same dispatch.

The 500 ms breaker of the previous design is gone: with holds capped at
`gateHoldMs`, waits can no longer add up across threads.

After-turn snapshots are skipped when nothing happened since the latest
checkpoint (an idle fork, a repeated event), or when the next message's
before-turn checkpoint already captured the same state. A turn the provider
starts on its own (a Claude Code wakeup, a finished background task) sends
no message, so no gate runs for it; this very session showed one start 3 s
after `turn/completed` with no `client/turn/requested` event. If such a turn
is already running when the idle event is handled, the after-turn checkpoint
is still taken, at the `turn/completed` mark, and flagged late because the
new turn may already have changed files.

## Mapping messages to checkpoints

Every checkpoint stores the thread's event high-water mark
(`threads.events.list({ order: "desc", limit: 1 })`). A message reference
carries `sourceSeqEnd`.

- A user message's "before" checkpoint is the latest before-turn checkpoint
  whose mark is at or below the message's `sourceSeqEnd`, unless an
  after-turn checkpoint (or a restore) was taken after it, which would mean
  it belongs to an earlier message. Otherwise the latest earlier checkpoint
  (or the target of a later restore) is offered as an explicit fallback.
- An assistant reply's "after" checkpoint is the first after-turn checkpoint
  with a mark at or above the reply's `sourceSeqEnd`; every reply in a turn
  maps to its turn's end. If that snapshot is missing, the next message's
  before-turn checkpoint is the fallback.
- Restores are kept in their own table, so they are placed in the checkpoint
  sequence by the pre-restore checkpoint each one took. A restore that
  stopped part way still ends an earlier message's claim on its checkpoint,
  but is never offered as a state to return to.

**Proven live** (bb 0.43.4, Codex): the gate runs before the message's first
event is appended. Message 2's before-turn checkpoint had mark 32 and the
message's `client/turn/requested` event was seq 33; for a message typed in the
app, the UI's "Rewind to here" sent `sourceSeqEnd` 78 (its
`client/turn/requested` event) and resolved to the before-turn checkpoint with
mark 77. Replies resolved to their turn's after-turn checkpoint (mark =
`turn/completed`).

## Restore

A restore is one host call under the workspace lock:

1. Capture the workspace and commit it as the **pre-restore checkpoint**.
   If that fails, nothing else runs.
2. Diff the current tree against the target (`diff-tree -r`) and **plan**
   (`src/host/plan.ts`). A path is changed only if its current content is in
   the pre-restore checkpoint, or it does not exist. Protected, and left as
   is:
   - existing paths the checkpoint does not capture (ignored, over the size
     cap, inside a nested repository), including directories that still
     hold such files and paths whose parent is an uncaptured file or symlink;
   - paths the user's own repository ignores (`git check-ignore`, read-only;
     it consults the user's index, so tracked files are never "ignored");
   - existing paths git cannot check (beyond a symlink, in a submodule).
     A missing path it cannot check is still created: nothing can be lost.
3. Build the **effective tree** (the target with protected paths dropped or
   kept at their current state) in a temporary index.
4. `git read-tree -m -u <current> <effective>` on the shadow index, which
   updates only differing files, removes deleted ones, and refuses to write
   through symlinks. When files are locked (on Windows, another program has
   them open) it retries up to three times (after 0.25, 0.75 and 1.5 s),
   each time first capturing what the failed attempt already wrote.
5. **Verify**: refresh, `diff-files` must be empty, deleted paths must be
   gone, and the index tree must equal the effective tree. Files that were
   uncaptured before the restore and are now visible are reported, not
   treated as failures.

`read-tree -u` alone is not enough: tested on git 2.54, it silently
overwrites ignored files and deletes ignored files inside a directory it
replaces with a file. Step 2 exists because of that.

The server refuses a restore while the thread or any thread sharing its
environment is `starting`, `active`, or `stopping`, explains why, and the UI
offers "Stop it and restore" (the CLI has `--stop-running`, and refuses to
stop the calling agent's own thread). From just before that check until the
files are written, every message to a thread in that environment is queued
(`wait`, "Rewind: restoring files…"), with automatic checkpoints on or off,
and re-attempted by `recheck` when the restore ends; its before-turn
checkpoint then holds the restored files. There is no short limit, because
the user started the restore; a row is released, with a warning in the
restore's result, only after the restore host-call limit (20 minutes). A
re-attempt another plugin triggers mid-restore is queued again. Send now,
and turns an agent starts by itself, skip the queue; the restore's result
warns about any turn that started meanwhile. The preview warns when git
HEAD moved since the checkpoint; commits and branches are never changed.

Undo restores the latest restore's pre-restore checkpoint, itself preceded
by a new pre-restore checkpoint, so undo can be undone too.

A restore can fail after its undo point exists, for example on a file it
has no permission to replace (`read-tree` updates the other files and then
fails). The host reports the error along with the pre-restore checkpoint.
If the host call itself is lost, the server looks the undo point up by its
ref. Such a restore is recorded as failed *with* its undo point: the error
says files may have changed, and Undo, which never skips a newer partial
restore for an older finished one, puts every file back. A restore that
failed before changing anything has no undo point and is skipped by Undo.

## Keeping the conversation in step

After a restore the thread's conversation still contains the undone turns:
the agent believes its edits are on disk and may re-apply them or build on
code that is gone. Rewind offers two ways to deal with that.

**Restore files and edit this message** (the "Rewind to here" preview for
your own messages, or `bb rewind restore <before-checkpoint> --yes
--edit-message "…"` / `--edit-message-file <path>`). You edit the message
first. Rewind restores the files to its before-checkpoint as a normal,
undoable restore, and only then calls `bb.sdk.threads.editMessage({
threadId, expectedRequestSequence, input, operationId })`. bb replaces the
selected turn and every later turn while keeping the workspace as it is
(Codex, Claude Code, Pi), so files and conversation go back together in the
same thread. `expectedRequestSequence` is the message's `sourceSeqEnd`,
its `client/turn/requested` event (verified live, see Measured live). bb
starts the edited turn without the dispatch gate, so Rewind takes its
before-turn checkpoint (the restored files) itself, just before the edit,
and drops it if the edit is refused. The files are written before the edit
is sent, so the new turn cannot start on half-restored files. The option is
offered only for messages a person typed (bb refuses others) and for
providers that can rewind a session. If bb or the provider refuses anyway,
the restore stays, the refusal is reported, and the note below is offered.

**The note.** After any restore that did not rewind the conversation,
Rewind stores a short note for the user's next message, for example "Files
were restored to before message 3 (“…”); turns 3–5 were undone. Re-read
files before editing." Messages are numbered from the timeline (paged
backwards, bounded; past the bound the note names the message by quote
only). The app shows it in a card above the thread's message box (a
composer banner) with Insert and Dismiss; the CLI prints it after the
restore. Rewind never sends it. It is dropped when you dismiss it, when you
send your next message, or when you undo the restore.

## What a restore cannot undo

Files come back; what commands did elsewhere does not. Every checkpoint
stores the commands that started since the thread's previous checkpoint
whose effects reach outside the workspace, found by reading only the
`item/started` events in that range (500 per page, at most 4 pages) and
passing each `commandExecution` through `src/effects.ts`: `git push`,
package publishes, database clients and migrations, deploy tools, mutating
`docker`/`podman`/`kubectl` commands, global installs, writes or deletions
outside the workspace path, and mutating `curl`/`httpie`/`wget` requests.
The detector parses shell syntax (quotes, heredocs, `&&`/`;`/`|`,
wrappers like `/bin/zsh -lc "…"` and `npx`), so `echo "git push"` and
`git push --help` do not count. Scans run in the background after each
snapshot; older checkpoints are filled in when listed.

The panel shows "This turn ran `git push`; Rewind can't undo that." on the
turn; the preview, `bb rewind restore --dry-run`, and the restore's result
list what the undone turns (and anything since the latest checkpoint) ran;
`bb rewind show` lists a checkpoint's own.

## Fork with files

1. Resolve the anchor. From a message: its `sourceSeqEnd` (a user message
   branches before it, a reply after its turn). From a checkpoint (CLI): a
   before-turn checkpoint branches before the message it preceded; others
   after the last reply they include (from `threads.timeline`).
2. `threads.fork({ sourceThreadId, sourceSeqEnd, environment: { type: "host",
   hostId, workspace: { type: "managed-worktree", baseBranch } } })` with no
   input, so the fork is created idle. The base branch is the checkpoint's
   branch (or the project default). Measured: idle forks provision their
   worktree eagerly (ready in about 2 s).
3. Wait (up to 10 minutes) for the fork's environment to be ready.
4. Restore the checkpoint into the new worktree. Both shadows are on the
   same machine: the commit is fetched from the source shadow by its ref
   (`git fetch <source shadow> refs/rewind/<id>`), never borrowed.
5. Only then send the optional prompt with `threads.send`.

The fork runs as a background job with a status the UI polls
(`forkStatus`) and the CLI waits for.

## Retention

- `thread.deleted` drops the thread's rows and refs.
- A daily schedule (03:17 server time) keeps each thread's newest
  `maxCheckpointsPerThread` (default 200) plus what its latest restore needs
  for Undo, drops archived threads' checkpoints after `retentionDays`
  (default 14) and failed attempts after a week, deletes refs the database
  no longer knows (older than an hour, so in-flight snapshots are safe),
  runs `git gc --prune=2.hours.ago` outside the lock, and removes shadows of
  workspaces that no longer have an environment or any checkpoint.
- `bb rewind prune [--dry-run]` runs it now; `--thread <id> --yes` deletes
  one thread's checkpoints.

## Bounded cost

| Bound | Value |
| --- | --- |
| Gate hold (bb's dispatch lock) | `gateHoldMs` (default 200 ms, at most 2 s) plus ≤ 250 ms for the event mark; hard limit 3.5 s |
| Message queued behind its checkpoint | 30 s (`sendAt`), then it goes |
| Message queued behind a restore | the restore host-call limit, 20 min |
| File size | `maxFileSizeMB` (default 10 MB) |
| Workspace | 100,000 files; 2 GiB of new or changed files per snapshot |
| Stored per-checkpoint file list | 200 entries |
| Patches | 256 KiB per file, 2 MiB per call |
| CLI output | 85% of `PLUGIN_CLI_OUTPUT_MAX_BYTES`, truncated with a note (JSON errors out instead) |
| Agent tool output | 16 KiB |
| Host calls | snapshot 5 min, restore 20 min (each git step 10 min), diff 2 min, gc 20 min |
| Gate samples and queued-message records | last 1,000 each |
| Command scan per checkpoint | `item/started` events only, 4 pages of 500; 20 effects kept |
| Timeline read for message numbers | 20 pages of 200 segments |
| Locked-file retries in a restore | 3 (0.25 s, 0.75 s, 1.5 s) |

## Measured live

bb 0.43.4 on macOS, this repository (71 captured files, `node_modules` and
`dist/` ignored), local host, Codex threads.

- Message gate, 8 dispatches that took a snapshot: waited p50 125 ms,
  p95/max 147 ms (snapshot p50 122 ms); 0 late, 0 failed. A brand-new
  thread's first dispatch skipped the gate in 0 ms (no environment yet).
- First snapshot of a fresh worktree (71 files, baseline): 269 ms.
- `bb rewind checkpoint` on a cold host worker, first snapshot included:
  0.47 s end to end.
- Fork with files, end to end through the CLI: 2.2 s.

With the queueing gate (61 dispatches, 30 of them real messages in other
threads whose snapshots take 0.6–1 s):

- **Held** (bb's lock): p50 43 ms, p95 202 ms, max 226 ms. **Queued**: 25
  messages, p50 840 ms, p95 6.8 s, max 24.8 s. **Recheck to re-attempt**:
  p50 6 ms, p95 29 ms.
- **A 40,000-file checkpoint**: the message was held 202 ms, queued with the
  card, kept in its wait through two re-attempts bb made on its own, and
  re-attempted 6 ms after the checkpoint was saved (24.8 s). The checkpoint
  was exact, not late. A message sent meanwhile to another thread was held
  202 ms, queued 381 ms (its own snapshot slowed to 309 ms), and went 17 ms
  after its recheck.
- **A restore deleting 40,000 files** (4 s): a message sent during it was
  queued ("Rewind: restoring files…"), checkpointed after the restore, and
  re-attempted 20 ms after the recheck. Its turn ran `ls e2e` and found the
  folder gone.
- **Restore files and edit this message**, on Codex and on Claude Code: bb
  accepted `expectedRequestSequence` = the message's `sourceSeqEnd` (its
  `client/turn/requested` event). The files went back (`one`, `extra.txt`
  gone), the new turn wrote `three`, and the timeline shows message 2
  replaced (event 48 became 84; 37 became 53). bb refused a message another
  thread had sent ("409: not an editable user turn"): the restore stayed and
  the note was offered, which is why such messages are no longer offered for
  editing. The edited turn does not pass the dispatch gate, so Rewind takes
  its before-turn checkpoint itself.
- **Orphan sweep**: disabling Rewind while a message waited on it released
  the message within about a second; after a reload the row stayed queued
  until the new load's startup recheck, about a second later.
- **`git push --dry-run`** in a turn showed up in `bb rewind show`,
  `restore --dry-run`, and the restore result.
- bb caps `threads.events.list` at 100 events and the timeline at 100
  segments per call; both are paged.

## Deviations from the brief, and why

- **`status` + `update-index`, not `git add -A`.** `git add -A` aborts on a
  nested repository without commits and hashes a file before any size check
  can skip it. Feeding the exact changed paths to `update-index --stdin`
  avoids both and needs no pathspec matching.
- **Explicit restore protection.** Planned in code before `read-tree`,
  because git treats ignored files as expendable (see Restore).
- **The shadow's ignore rules are composed**, not only `info/exclude`
  copied: the excludes file and ancestor `.gitignore` files are re-based
  onto the workspace, and newly ignored files leave the shadow index.
- **Parentless commits** so retention can actually free space.
- **Hold briefly, then queue**, instead of holding a message for the whole
  snapshot: the hook runs under a server-wide lock, so a slow snapshot used
  to delay every thread's messages by up to the old 5 s budget.
- **Steers are not held**, and messages queued behind a running turn are
  snapshotted at drain: holding either would only add latency.
- **A re-attempt while the checkpoint is still being saved keeps the
  message queued**, where the brief said every re-attempt of a row Rewind
  queued proceeds. bb re-attempts queued rows on its own (seen live 2.8 s
  after a re-queue, with no recheck from anyone), and every recheck wakes
  every row. Followed literally, the rule released a 40,000-file
  checkpoint's message after 4 s, and that checkpoint came out late, the
  opposite of the point of queueing. The message is still queued only once,
  for at most 30 s, and Send now always sends it at once.
- **Rewind's queued rows are recognized two ways**, by `waitingOn` and by the
  ids `message.queued` reports, because when several plugins wait only the
  first owns `waitingOn` and the others' reasons are appended to it.
- **The fallback note is a suggestion, never a message.** The brief asked for
  nothing to be sent on the user's behalf; the note is inserted into the
  draft only when the user clicks Insert.
- **The new-thread baseline** is a before-turn checkpoint with mark 0 taken
  on `thread.active`, flagged late only if a file-touching tool item had
  already started.
- **`bb rewind undo` needs `--yes`** like restore: it writes files too.
- **Palette "checkpoint now"** borrows the RPC client of an invisible
  app-wide component, because palette commands run outside React and the
  SDK has no non-hook RPC client.
- **"Rewind to here" is where bb shows message actions**: typed user
  messages and assistant replies. Messages another thread sent (rendered as
  "Message from …" rows) have no action bar in bb 0.43; the panel and
  `bb rewind` cover them.

## Cross-platform

- **Linux** was run locally in a `node:22-bookworm` container (git 2.39,
  as a non-root user so permission tests behave as they would for a normal user): typecheck
  and every test pass.
- **Windows** was reviewed, not run:
  - no executable bit: the shadow sets `core.fileMode=false`;
  - symlinks need a privilege or Developer Mode: the shadow probes symlink
    creation once, in its own directory, and sets `core.symlinks` from it;
  - long paths: `core.longpaths=true`;
  - locked files during a restore: retried, then reported as a partial
    restore that Undo reverses;
  - case-insensitive NTFS: case sensitivity is probed per workspace, and
    verification compares exact names;
  - paths: git always gets `/`-separated paths; filesystem calls use Node's
    `path`.

  Tests that need POSIX permissions or unprivileged symlinks are skipped on
  Windows.

## Limitations

- Files only: commits, branches, the stash, and HEAD are never restored.
  Only the executable bit of permissions is tracked; empty directories,
  ownership, extended attributes, and timestamps are not.
- Threads sharing a workspace share its files: restoring one restores it for
  all (the preview says how many threads share it).
- The first message of a brand-new thread is checkpointed when the thread
  becomes active, not at dispatch; a very fast first tool call can land in
  it (flagged late).
- Turns a provider starts on its own get no before-turn checkpoint; the
  previous turn's after-turn checkpoint is their starting point (flagged
  late if the new turn had already begun).
- A message whose checkpoint takes longer than `gateHoldMs` waits in the
  queue (shown on its card) until the checkpoint is saved, 30 s at most.
- Send now, and turns an agent starts by itself, skip Rewind's queue: such a
  turn can start while a restore writes files (the restore warns), and a
  message sent with Send now before its checkpoint finished gets a late one.
- "Restore files and edit this message" depends on bb and the provider
  accepting the edit (Codex, Claude Code, Pi in bb 0.43). The conversation
  edit is bb's and cannot be undone by Rewind; the files can.
- The command scan is a heuristic over shell syntax: a command hidden in a
  script file, an alias, or a program the detector does not know goes
  unreported, and a read-only database query is reported as a database
  client run.
- Case-only renames are not recorded on case-insensitive filesystems: like
  git with `core.ignoreCase`, the shadow keeps the name it first saw, so a
  restore brings back the content but not a case-only rename. Restoring
  another workspace's checkpoint (a fork) does apply case differences.
- Fork needs a git repository and a provider that can fork mid-history
  (Codex, Claude Code, Pi); others fail with bb's error.
- Remote machines follow the same code path (host RPC to the environment's
  host) but were not tested live.
- Windows is CI-ready, untested live (see Cross-platform).
- Non-UTF-8 file names are captured and restored byte-exact but shown lossily,
  and cannot be used with `--path`.
- After a message edit, the panel keeps the replaced turns' checkpoints, so
  its turn numbers can run ahead of the conversation's message numbers.
