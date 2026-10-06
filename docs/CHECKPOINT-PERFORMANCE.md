# Checkpoint performance investigation

## Implemented and reevaluated

Two optimizations are implemented in `src/host/shadow.ts`:

1. List the shadow index once and intersect raw-byte paths in memory, instead
   of repeatedly matching batches of 500 tracked-but-ignored pathspecs.
2. Reuse the loaded commit/tree pair when the requested comparison baseline is
   the latest shadow commit, avoiding `cat-file` and `rev-parse`. Older baselines
   still use the normal validation/resolution path.

The plugin was rebuilt and reloaded successfully. Capture/restore policy,
workspace locking, and the before-turn gate are unchanged.

### Production-code reevaluation

The benchmark now measures the actual production engine, without substituting
any algorithm. Three repetitions per scenario:

| Workload | Before | Implemented | Improvement |
| --- | ---: | ---: | ---: |
| 7,400 files / 462 forced; unchanged | 317 ms | 112 ms | 65% less time; 2.8× |
| Same workload; one edit | 373 ms | 172 ms | 54% less time; 2.2× |
| 10,000 forced files; unchanged | 4,958 ms | 107 ms | 98% less time; 46× |
| Same stress workload; one edit | 4,929 ms | 200 ms | 96% less time; 25× |
| 10–1,000 ordinary files; unchanged | 109–119 ms | 76 ms | About 30–36% less time |

The representative before/after was rerun during implementation. Stress and
ordinary-file baselines are the earlier same-machine investigation runs below.
Cold-capture timings vary with filesystem load; repeat-capture improvements are
the primary result, not a guarantee that all first snapshots are now fast.

An intermediate run with **only** the single-scan change took 135 ms unchanged
and 181 ms for one edit. The additional known-baseline shortcut reduced those
to 112 ms and 172 ms in the final representative run. Command tracing confirms
that the unchanged hot path no longer runs `cat-file` or a shadow tree-resolution
`rev-parse`.

Both representative and stress unchanged scenarios pass the 200 ms diagnostic
threshold. After reload, three real manual checkpoints of this plugin's small
workspace succeeded and deduplicated, with host durations **109, 68, 68 ms**.
These live smoke checks do not measure the dispatch queue or imply that the
historic global p95 has already changed.

The separate queue-release delay remains unresolved: some long “saving a
checkpoint” waits occur **after the checkpoint has finished**. Cold snapshots
also still spend seconds on initial object creation (about 4.5 seconds of the
5.57-second final stress cold capture).

## Original evidence from the running plugin

Read-only `bb rewind status --json`, with the latest 1,000 gate samples:

| Measurement | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Full gate snapshot job | 600 ms | 1,443 ms | 14,315 ms |
| Message queued | 673 ms | 2,028 ms | 38,590 ms |
| Recheck requested → next hook attempt | 8 ms | 272 ms | 37,295 ms |

307 dispatches queued behind a checkpoint; no recorded checkpoint failures or
messages released before their checkpoint finished in this sample.

A separate read-only query of the latest 1,000 successful checkpoint rows
showed that the heavily used LearnAnything worktree had roughly 7,400 captured
files, a host-duration median of 526 ms, and **745 of 766 checkpoints deduped**.
Its current user index contains 462 tracked-but-ignored files. A second worktree
and the project checkout also contained 462 such files and had host medians
around 550–650 ms. Smaller plugin repositories without tracked-but-ignored
files generally had host medians around 125–180 ms.

Those are observational samples, not proof that every slow checkpoint has the
same cause. Gate samples and checkpoint rows are different populations, and
new checkpoints can shift the last-1,000 window.

### Saving versus releasing

One completed wait recorded:

- Host snapshot: **452 ms**.
- Dispatch gate start → checkpoint completed: **1,251 ms**.
- Recheck requested → next hook attempt: **37,295 ms**.
- Total queued time: **38,590 ms**.

Four other waits had 32–36 seconds between recheck request and the next attempt,
while checkpoint completion took roughly 0.8–1.6 seconds from gate start.

`RewindService.releaseWaits()` records `recheckAt` before calling BB's recheck
API. Therefore this proves a delay after requesting release, **not** a proven
BB scheduler bug: other hooks, a running turn, server load, or the recheck call
itself may explain it. Trace those boundaries before changing release logic.

## Original controlled prototype benchmark

The following measurements describe the initial investigation, before the
production implementation above. The prototype override has since been removed.

The opt-in harness calls the real host entry through the SDK harness, with real
Git, disposable repositories, warm persistent indexes, and three repetitions
per scenario. No live workspaces or shadow stores are modified.

Files contain about 140 bytes. They are tracked first, then a directory is
ignored to reproduce the tracked-but-ignored case. Measurements include host
RPC validation/serialization but not a remote daemon, service lookups, or
message-queue release. This machine ran Node v24.21.0 and Apple Git 2.54.0.

| Workload | Current unchanged median | Single-scan prototype | Improvement |
| --- | ---: | ---: | ---: |
| 7,400 files; 462 tracked-but-ignored | 320 ms | 137 ms | 2.3×; 57% lower |
| 10,000 files; all tracked-but-ignored | 4,958 ms | 138 ms | 36×; 97% lower |

Representative one-file-edit medians were **370 → 209 ms**. Stress-case
one-file-edit medians were **4,929 → 235 ms**.

For comparison, the initial small-workspace baseline (10–1,000 ordinary tracked
files, no ignored tracked files) took about 109–119 ms unchanged and 160–164 ms
for one edit. Git's persistent index already avoids rehashing unchanged files;
reimplementing incremental hashing is not the first optimization to make.

The 200 ms diagnostic threshold is the existing default gate-hold budget, not
a promise that the entire live dispatch will fit within it. The representative
and stress current implementations exceeded it; the prototype passed for
unchanged checkpoints. The benchmark intentionally fails when that optional
threshold is exceeded.

### Attribution

`src/host/shadow.ts`, `indexedAmong()`:

```text
for each group of 500 forced paths:
    git ls-files -z --cached -- <500 pathspecs>
```

`capture()` calls this for all tracked-but-ignored paths every time, even when
Git status reports no changes. Caching `trackedButIgnored()` for one minute
only caches the list; it does not eliminate this repeated index lookup.

On the representative unchanged baseline:

- Git status: 24 ms.
- Two `ls-files` calls: 204 ms total, primarily the forced-path query.
- Other commands and overhead: the remainder of the 313 ms first sample.

On the final stress unchanged baseline's first sample:

- 21 `ls-files` calls: **5,144 ms** of **5,254 ms** total.
- Git status: 24 ms.

The prototype changes only the private `indexedAmong()` method in the test
process:

```text
git ls-files -z --cached
decode paths using the existing byte-preserving conversion
intersect with Set(forcedPaths)
```

The stress unchanged prototype performs two `ls-files` calls total (the index
listing plus the existing chat-storage cleanup scan), taking 32 ms. It still
captures all expected files, detects the edited forced file, and deduplicates
unchanged trees. No skip policy or checkpoint boundary is weakened.

### Cold checkpoints remain expensive

The final stress cold checkpoint improved **10.16 → 5.68 seconds**, but initial
`update-index` hashing/object creation still took about **4.7 seconds** in both
runs. The first diff's line statistics took about **0.46 seconds**.

This optimization primarily helps repeated checkpoints. First snapshots still
need a full self-contained capture. Do not use alternates into the user's Git
object store or exclude tracked generated files automatically: both change
Rewind's durability/capture guarantees.

## Completed optimizations and remaining opportunities

### 1. Single-scan forced-path membership — implemented

`indexedAmong()` now lists once and intersects using byte-preserving internal
paths. NUL parsing, Git runner bounds, and the workspace mutex are retained.

New public host snapshot/restore integration coverage exercises 601 forced
files at the exact file limit, deduplication, edits, deletion, chmod and type
changes, oversize-file protection, literal/Unicode names, cache refreshes after
user-index and ignore-rule changes, and ignored files / user `.git` preservation.
Existing unreadable-file and restore safety tests also pass.

A raw non-UTF-8 filename test is present but skipped on this machine because
APFS rejects its fixture with `EILSEQ`; it still needs execution on a filesystem
that supports such names. When there is no shadow index on first capture,
membership is empty; avoiding even that first lookup remains a possible follow-up.

### 2. Remove provably redundant Git calls — known baseline implemented

For `compareTo === state.lastCommit`, `commitCaptured()` now uses the
already-loaded `state.lastTree`. The new baseline integration test verifies that
older comparisons still report changes even when the current tree deduplicates,
and missing baselines still fall back correctly.

A further `write-tree` shortcut is **not implemented**. It would need proof that
capture performed no index-content mutation. Preserve scans for new files,
deletions, ignored-path cleanup, and forced files; do not blindly reuse a
checkpoint based on conversation state alone. Final warm tracing still shows
about 17–18 ms in `write-tree`; whether that shortcut is worthwhile needs its
own correctness tests and measurements.

### 3. Separate queue latency from snapshot latency — high user-visible value

Measure the timestamp of successful recheck completion, the next actual queue
attempt, other hook waits, and thread readiness. Keep the current exact
before-turn checkpoint behavior. Raising `gateHoldMs` can hide short waits but
holds BB's server-wide dispatch lock longer and does not speed up saving.

Do not “fix” this by sending messages while a pre-turn checkpoint is still
being captured. The worst measured release delays are tens of seconds beyond
saving, so trace the queue mechanism rather than tuning Git for them.

### 4. Add phase timings before broader optimizations

Distinguish:

- Event-mark and storage-directory lookup.
- Host worker startup/transport.
- Workspace-lock wait.
- Ignore sync, status, forced membership, file checks, index update, tree/ref
  creation, and diff statistics.
- Metadata persistence/publish.
- Recheck request/completion and actual dispatch.

Successful checkpoint `durationMs` currently starts inside `Shadow.snapshot()`
**after** acquiring the workspace lock. It excludes lock wait, transport, and
storage lookup. Gate `snapshotMs` is broader. Do not label their difference
as a specific cause without instrumentation.

### 5. Cold capture / scan optimizations — only if the phase data justifies them

Investigate earlier shadow-index warm-up, diff-stat cost, or verified Git scan
features after the repeat-checkpoint fix. Rewind intentionally pins fsmonitor,
untracked-cache, split-index and filters off; enabling them needs cross-platform
and invalidation/correctness testing, not just a config toggle.

## Reproducing

Regular `npm test` does **not** run these performance experiments. Run separately
so timing is not distorted by the ordinary parallel regression suite:

```sh
# Actual production engine, representative workload.
REWIND_BENCH_SIZES=7400 REWIND_BENCH_FORCED=462 \
REWIND_BENCH_MAX_MS=200 REWIND_BENCH_TRACE=1 \
npx vitest run --config vitest.perf.config.ts

# Stress workload.
REWIND_BENCH_SIZES=10000 REWIND_BENCH_FORCED=10000 \
REWIND_BENCH_MAX_MS=200 REWIND_BENCH_TRACE=1 \
npx vitest run --config vitest.perf.config.ts

# Ordinary-file baseline / regression check.
REWIND_BENCH_SIZES=10,100,1000 REWIND_BENCH_MAX_MS=200 \
npx vitest run --config vitest.perf.config.ts

# Omit REWIND_BENCH_MAX_MS to measure without a timing assertion.
# REWIND_BENCH_ROUNDS defaults to 3.
```

The output includes cold, unchanged, one-file-edit and `force: true` snapshots,
plus optional command timing totals. Here `force` bypasses the unsupported
workspace cooldown; it does **not** force rehashing all files. The private
prototype replacement and its `REWIND_BENCH_SINGLE_SCAN` option are removed.

## Verification

- `npm run check`: TypeScript checking and **199 passed, 1 skipped** (raw filename
  fixture rejected by APFS), across 12 test files.
- Representative, stress, and small-workspace production benchmarks: passed
  the requested 200 ms unchanged-checkpoint threshold.
- `bb plugin build`: passed. BB warns that the existing SDK pin is 0.5.9 while
  its current SDK is 0.6.15; the pin/lockfile were not changed for this engine fix.
- `bb plugin reload rewind --json`: succeeded; Rewind is enabled and running.
  No pending checkpoints, running restores, or running forks were present at
  the pre-reload check.
- Three post-reload live checkpoints: successful, deduplicated, 109/68/68 ms
  host duration. No live restore was performed.
- Existing README and promo/media changes were left untouched.

Safety checkpoint before rebuilding: `ck_0muwi0e2yr4hcbba`.
