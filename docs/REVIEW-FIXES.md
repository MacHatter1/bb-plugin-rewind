# Rewind v0.1.1 full-review fixes

Final verification handoff for reviewed commit `16e7b033c930cd17ace0ed858314669e68fbc6e9`, on `fix/restore-safety-review`. Package version remains `0.1.1`; the compile contract remains SDK `0.5.9`.

**All seventeen findings are fixed, tested and independently accepted.** The final read-only verifier for workflow `wfr_177458dd-e671-4d23-ab9a-3ada9bc8c194` returned `passed: true`, all twelve grouped criteria met and no problems. It individually accounted for F01–F14 and U01–U03 against the final application diff. Earlier verdicts rejected F01's pending-snapshot dispatch race and F06's cancelled capture preparation; their subsequent real-filesystem repairs and regression evidence remain documented below. All three additional candidates were reproduced rather than dismissed.

The captain then inspected the changes, ran a fresh check/build and benchmarks, and verified protected files. The first captain stress diagnostic failed at 294 ms; the release control and one fixed-source recheck are reported below, without discarding that failure or claiming a controlled speedup. No source changes followed the final verifier; only this handoff and the evidence ledger were finalised. Nothing was committed, published or reloaded.

Evidence directory: `$HOME/.bb/thread-storage/thr_yhuti7cj3n/fixes/`. `finding-ledger.json` records individual commands, exits, red reasons, green results, source files and current regression names. `completion-result.json` retains the final independent verdict; `captain-verification.json` records the fresh captain checks and all captain benchmark samples. Earlier benchmark/repair evidence remains intact.

## Individual dispositions

### F01 — fixed, tested and independently verified

Canonical, host-backed directory identity coordinates all same-host environments, discovery/stop actions, restore gates, warnings and host locks. Raw shadow addresses/checkpoint paths remain unchanged; historical refs and Undo work through aliases. Self-contained historical diffs/imports remain usable even after the source working directory disappears. Identity ambiguity during a restore queues dispatches; ordinary non-restore dispatches do not gain an unconditional identity RPC. The server's 3,500-ms hard timeout and exception fallback now synchronously consult active restores: an unresolved same-host identity waits (including with checkpoints disabled), with wait bookkeeping retained for completion/recheck. Normal snapshot failures still proceed. Unresolved distinct workspaces on that host may conservatively wait until identity is known. Expired waits cannot bypass an active restore, and overlapping restores are refused. Configured chat-storage and in-workspace shadow-store exclusions also survive aliases.

Regressions: `F01 shares restore gates and active discovery across environment aliases`; `F01 preserves historical refs and workspace Undo through a symlink environment`; `F01 preserves configured chat-storage protection through workspace aliases`; `F01 never captures an in-workspace shadow store through an alias`; `F01 preserves self-contained historical diffs and imports after the source workspace vanishes`. Includes checkpoints-disabled dispatch, distinct-workspace control, stop, post-start warning and historical bytes. Evidence: `F01-{red,green}.log`, `F01-storage-{red,green}.log`, `F01-F02-supplement.log`. Repair regression: `F01 keeps a stalled-identity dispatch queued past the server hard timeout (enabled=%s)`, with deterministic identity/write barriers and fake deadline timers, rejected-identity control, and completion/recheck. `F01-hard-timeout-red.log` reproduced two unsafe `proceed` decisions; `F01-hard-timeout-green.log` passes both enabled/disabled cases.

Second repair: recheck active canonical restore ownership immediately before final dispatch permission, after identity/event/snapshot waits. Regression `F01 rechecks restore ownership after a completed snapshot response (%s)` pauses an alias sibling's completed real snapshot response, starts a restore through its destructive-call barrier, then releases the response. Its red returned `proceed` and admitted ordinary agent writes; the green queues the alias sibling, retries after completion and permits a distinct-workspace control without overwriting its bytes. Fake timers hold deadline delivery only; real Git/filesystem work and SDK hooks/RPC are unchanged. Evidence: `F01-response-race-red.log` (exit 1, alias failure/distinct pass), `F01-response-race-green.log` (exit 0, eight F01/F02 cases). No unconditional identity call is added to ordinary dispatch.

### F02 — fixed and tested

Enumerate actual SDK thread pages of 200, inspect persisted and runtime activity, detect repeated pages and fail closed on page errors. The world adapter now honors limits/offsets rather than concealing production pagination.

Regressions: `F02 blocks an active sibling at row 201 and fails closed on page errors`; `F02 agrees across preview restore Undo and stop for runtime-only active self at row 201`. Evidence: `F02-{red,green}.log`, `F01-F02-supplement.log`.

### F03 — fixed and tested

Retention protects the target/pre-checkpoint selected by canonical workspace-level latest eligible Undo, rather than a newer no-write failure. Protection applies to count limits and failed-age/archive expiry, including an archived owner when a sibling still offers Undo.

Regressions: `F03 retains the Undo selected after a newer no-write failure`; `F03 preserves offered workspace Undo even after the owner is archived`. They run actual fixture retention and then restore original bytes. Evidence: `F03-{red,green}.log`, `F03-archive-{red,green}.log` and U02's retention/reload case.

### F04 — fixed and tested

Memoized ancestor checks remove already-indexed descendants after real nested `.git`/gitfile transitions, including unchanged files. Restore separately protects current nested boundaries and absent old targets.

Regression: `F04 drops unchanged indexed descendants of a new nested repository (%s) and protects old targets`, for a directory and a separate-git-dir gitfile in a non-Git parent. Nested bytes and Git data remain unchanged. Evidence: `F04-{red,green}.log`, final full check.

### F05 — fixed and tested

Non-Git restore planning checks current composed shadow ignore rules for absent as well as existing targets. Native Git repositories retain the real user-index tracked-but-ignored exception.

Regression: `F05 protects existing and absent targets using current ignores (%s)` for local, isolated global and repository-ancestor rules. An absent `.env` stays absent and an ignored existing log keeps its bytes. Existing native tracked-ignored controls also pass. Evidence: `F05-{red,green}.log`, `F05-matrix-green.log`.

### F06 — fixed, tested and independently verified

Carry the host signal through lock admission, revision/capture preparation, bounded ignore reads and Git patch generation. Cancellation cannot admit queued capture. A cancelled waiter leaves its predecessor's tail registered until it settles, so a following request cannot bypass an active lock. Actual restores still deliberately finish after entering the write phase. Second repair propagates the effective request signal into memoized nested-repository probes, stat/readability checks, policy/forced-membership loops and bounded map workers. Checks before/after filesystem awaits prevent further admission after cancellation. Already-admitted non-abortable Node I/O is drained before releasing the workspace lock; read errors cannot swallow cancellation.

Regressions: `F06 cancelled queued diffs never begin capture and release the queue`; `F06 aborts an in-flight Git patch and the next snapshot obtains the lock`; `F06 cancelled queued work cannot orphan the still-running workspace lock`. Real I/O/process barriers replace timing-based race assertions. Evidence: `F06-{red,green}.log`, `F06-lock-{red,green}.log`.

Added regressions: `F06 stops capture at the first cancelled nested-boundary probe` (300 directories; red 300 probes, green at most one and none after cancellation); `F06 bounds cancelled capture stat workers (%s)` (300 changed files/reduced-cap indexed files; both red 300 probes, green at most 32 admitted probes, zero post-cancel admissions/readability calls). Deterministic delegated-I/O barriers also prove the request/lock remain owned until an admitted worker drains, then the next snapshot succeeds. `F06 finishes and verifies a real restore after write-phase cancellation` proves actual restores still finish, verify bytes and retain the Undo ref when the request aborts at the real write process. Evidence: `F06-capture-nested-{red,green}.log`, `F06-capture-stat-red.log`, `F06-capture-policy-red.log`, `F06-capture-workers-green.log`, `F06-capture-drain-green.log`, `F06-capture-final-green.log` (all seven F06 cases). Expanded drain/write-phase controls are supplemental green evidence, not fabricated original reds.

### F07 — fixed and tested

Recursive batch isolation replaces serial per-path fallback, with at most 64 operations and a 30-second budget. Cancellation propagates; unresolved paths remain unknown/protected, including unsafe absent creates. The known captured-ancestor symlink replacement exception remains.

Regression: `F07 isolates one real submodule path among 1001 changes within a bounded Git budget (%s)`, with normal, deadline-exhausted and cancelled variants. Original evidence measured **1002** calls; normal green asserts a justified upper bound of 32. Exhaustion protects all 1001 changes with no planned writes/creates. Evidence: `F07-{red,green}.log`, `F07-supplement.log`.

### F08 — fixed and tested

Closed disclosures do not mount/fetch `FileDiffs`. Optional workspace/request-scoped comparison handles retain immutable tree pairs for patches: 32-entry worker cap, two-minute TTL, shadow-only pins, explicit refresh/release, eviction/disposal cleanup and rejection of expired/wrong-workspace/cold-worker handles. New comparisons sweep cold-worker leftover pins; retention removes expired crash leftovers. Legacy no-handle RPC/CLI calls remain supported.

Regressions: `F08 does not fetch diffs inside a closed preview disclosure`; `F08 reuses immutable comparison trees for patches without recapturing`; `F08 rejects expired, wrong-workspace and cold-worker handles and releases pins`. Three patches reuse the original comparison after workspace changes. Evidence: `F08-{red,green}.log`, `F08-host-{red,green}.log`, `host-supplement2.log`.

### F09 — fixed and tested

Verification constructs a skipped Set once and checks exact paths/slash ancestors. It no longer copies/scans every skipped prefix for every leftover. Work depends on input construction and path depth, not skipped-count × leftover-count.

Regression: `F09 verifies large disjoint skipped and leftover sets with bounded output`: 600 disjoint skipped paths and 600 leftovers introduced at the real `read-tree` process boundary, accurate totals and capped listing. Complexity red is an explicitly permitted **source audit**, not a fragile speed assertion: reviewed source contains `[...skippedPaths].some`, changed source does not. Evidence: `F09-red.log`, `F09-source-{red,green}.log`, `F09-green.log`.

### F10 — fixed and tested

Data/errors are tied to complete thread/request identity and loaded generation; mismatches disappear during render. Restore/stop/edit require a successful matching preview, with a live freshness guard that also works before React commits another render. Dialog/message identity resets discard old local text. Async stop continuations cannot use a replacement or invalidated preview.

Regressions: `F10 suppresses stale restore controls on a delayed then rejected target switch`; `F10 remounts an open edit dialog across thread/message identity changes`; `F10 cancels the pending stop-and-restore continuation after preview invalidation (%s)` for committed and same-batch invalidation. The batched supplement initially sent a restore RPC, then passed after the live-generation guard. Evidence: `F10-{red,green}.log`, `F10-supplement.log`, `F10-batch-check.log` (red), `F10-batch-green.log`.

### F11 — fixed and tested

Persist previous size policy and revalidate indexed sizes on decreases/unknown legacy policy, not every stable capture. Remove/report unchanged newly over-cap files. Restore independently protects over-cap current and target entries, including absent oversized old targets. Capture shares one index walk across policy/forced-membership/skip checks.

Regression: `F11 revalidates unchanged indexed files after lowering the cap and protects oversized old targets (%s)`. The added legacy-policy case removes `maxFileBytes` from the disposable persisted state and disposes/recreates the public host-entry worker before capture/restore. It checks unchanged-file removal/reporting and existing/absent old-target protection. Evidence: `F11-{red,green}.log`, `F11-U03-cold-legacy-green.log`, current full check and stable-policy production traces. The legacy supplement already passes the prior implementation; it closes a verification gap, not a newly reproduced code defect.

### F12 — fixed and tested

Checkpoint-only forks search backwards across real 100-row cursor pages, up to 30 pages, to establish before/after/manual boundaries. Missing marks, unproven pagination boundaries, broken/repeating cursors and exhaustion fail before fork/prompt creation; explicit anchors retain their behavior.

Regressions: `F12 pages old %s fork boundaries before creating a fork` (before-turn/after-turn/manual); `F12 fails the bounded timeline search before any fork or prompt is sent`. Evidence: `F12-{red,green}.log`, final full check. A supplemental CLI test initially used `--json`, whose failed-job JSON legitimately exits zero; it now tests the non-JSON failure exit instead of changing the CLI contract.

### F13 — fixed and tested

Keep raw page count/last sequence separate from locally filtered command rows, so a full nonmatching page does not end the scan or cache a false empty summary.

Regression: `F13 continues full raw event pages with no locally matching commands`: SDK type filtering rejected, 100 unrelated rows, then real `git push`; warning checked in preview, later cached checkpoint/list/CLI show, repeated preview and restore. Evidence: `F13-{red,green}.log`, `F13-cache-green.log`.

### F14 — fixed and tested

Read ignore sources through bounded handles, at most 1 MiB plus an overflow sentinel, close in `finally`, and reject overflow/read errors instead of silently dropping rules. Growth after stat is detected. Missing sources remain normal. Unsafe restore preparation writes no user bytes; failed automatic capture still releases dispatch.

Regressions: `F14 refuses oversized ignore sources with rules beyond the cap before restore writes (%s)` for global/info/ancestor sources; `F14 bounds reads during ignore-source growth and closes handles after errors` (including exact threshold); `F14 fails open dispatch with a clearly failed checkpoint on an oversized real ignore source`. Evidence: `F14-{red,green}.log`, `F14-resource-green.log`, `F14-matrix-green.log`, `F14-dispatch-green.log`.

### U01 — reproduced, fixed and tested

Isolated real global `core.ignoreStat=true` reproduced missed external edits. Shadow Git pins it false and clears legacy shadow assume-unchanged flags once, recording migration state. The user index/configuration is not changed.

Regression: `U01 captures external edits with inherited ignoreStat and repairs legacy flags`, including disposed/recreated worker, real legacy flags, restored bytes and unchanged user-Git fingerprint. Evidence: `U01-{red,green}.log`, `host-supplement2.log`.

### U02 — reproduced, fixed and tested

Real fixture writes followed by discarded SDK transport response/unavailable ref lookup reproduced false no-write reporting. Persist restore/pre-checkpoint identity before sending the destructive call; unavailable is distinct from authoritative missing. Uncertainty warns files may have changed, keeps retention/Undo identity, refuses older fallback and resolves the same ref after reconnect/reload. List/UI use the workspace-level selected Undo.

The repair also propagates filesystem errors other than authoritative `ENOENT`, rejects fatal Git failures, and distinguishes a genuinely missing ref from unreadable/malformed loose refs, corrupt packed refs, dangling objects and non-commit objects. Git's quiet ref lookup returns 1 for unreadable/malformed loose refs too; a separate loose-path check prevents treating that as absence. Existing missing-store/missing-ref no-write controls still return null.

Added regressions: `U02 rejects unavailable saved Undo refs instead of reporting absence (%s)` (eight real-store/external-resource variants); `U02 reports authoritative absence for an uncreated shadow store`; `U02 preserves real-write Undo identity when recovery hits filesystem EACCES and reconnects after reload`. The server test confirms truthful may-have-changed reporting, retained identity during unavailable Undo/reload, rejection of older Undo, and original-byte recovery after access returns. Evidence: `U02-host-lookup-{red,green}.log` (four original false-null results), `U02-loose-ref-{red,green}.log` (two additional false-null results), `U02-packed-ref-green.log`, `U02-EACCES-reload-green.log` (supplements, not invented reds).

Original regressions: `U02 recovers an uncertain real-write restore after transport loss and reload`; `U02 persists uncertain identity before a delayed restore response and survives server reload`. Includes eight-day fixture retention, unavailable Undo, older-explicit-Undo rejection and actual recovered bytes. Existing authoritative missing-ref/no-write and partial-restore controls pass. The interruption red temporarily disabled only the new pre-call durable record, then restored it immediately. Evidence: `U02-{red,green}.log`, `U02-interruption-{red,green}.log`, final full check.

### U03 — reproduced, fixed and tested

Real `git rm --cached` of a forced ignored path, with unchanged ignore text and external clock expiry, reproduced continued capture. Membership cache observes the user index's filesystem stamp and TTL; persisted membership hash reconciles removals even without changed ignore text. Stable captures retain one shadow index scan and older-baseline deduplication.

Regressions: `U03 stops capturing an untracked forced ignored file without ignore edits after TTL`, warm removal and >60-second expiry; `U03 reconciles removed forced membership across a cold worker without changing ignores (expired=%s)`, removal while the worker is down followed by recreation, both before/after TTL. Each restores the old target without touching private bytes; cold cases also fingerprint the user Git data. No internal cache clearing or ignore edits manufacture the transition. Evidence: `U03-{red,green}.log`, `host-supplement2.log`, `F11-U03-cold-legacy-green.log`. The cold supplement passes without another application change.

## Verification

- Original pre-change `npm run check`: exit 0 (`baseline.log`); fresh pre-repair baseline: exit 0, **242 passed, 1 skipped** (`revision-baseline.log`).
- Fresh pre-second-repair baseline `npm run check`: exit 0, **257 passed, 1 skipped** (`repair2-baseline.log`), before this worker's application source changes.
- Second repair's `npm run check`: exit 0, **12 files; 263 passed, 1 skipped** (`repair2-check.log`); prior repair: 257 passed (`revision-check-release.log`). This runs **`tsc --noEmit` and Vitest only**, not lint. Earlier test-only TypeScript annotation errors remain recorded, not product reds.
- Second repair's final-source `bb plugin build`: exit 0 (`repair2-build.log`; earlier builds remain in `revision-build-complete.log`/`revision-build.log`). Expected installed-SDK mismatch warning only; no `bb plugin types`, dependency update or reload.
- The existing non-UTF-8 exact-file-limit test skips because APFS rejects raw invalid UTF-8 filenames with `EILSEQ`. The skip existed in the baseline; it was not added to conceal a regression.
- Latest `git diff --check`, all eight protected hashes/promo inventory, branch/HEAD/version/pins, unchanged benchmark assertions/dependencies/staging and repository fixture inventory are recorded in `repair2-safeguards.json` (earlier evidence remains in `revision-safeguards.json` and `safeguards.json`/`safeguards.log`).

### Final independent and captain verification

- Final independent verdict: **all twelve grouped criteria met, all seventeen IDs accounted for, no problems** (`completion-result.json`). Its fresh check passed **263 tests, 1 pre-existing skip**. Its five sequential benchmark matrices passed, with representative/stress diagnostic medians **193/115 ms**. The read-only verifier inspected the builder's build receipt rather than writing build artefacts.
- Fresh captain `npm run check`: exit 0, **12 files; 263 passed, 1 pre-existing skip** (`captain-check.log`).
- Fresh captain `bb plugin build`: exit 0 (`captain-build.log`), including host/server/app artefacts. The existing installed-SDK `0.6.15` versus pinned `0.5.9` warning was left unchanged; no reload or dependency change.
- All eight protected file sizes/SHA-256 hashes match `preserved-files.json`, with no additional promotional files. Branch/HEAD, package version, SDK pin, dependencies, staging and benchmark assertions remain unchanged. `git diff --check` passes. `captain-verification.json` records these safeguards and final artefact/source hashes.

### Production checkpoint benchmarks

Each command below uses the existing production benchmark. The earlier builder's normal matrices and representative diagnostic exited 0; its stress diagnostic exited **1** at **218 ms**. The first independent verifier subsequently passed all five matrices (diagnostic medians **84/91 ms**, per its returned verdict). Repair-run results and current limitations follow the historical measurements. No assertions/config/source were weakened.

```sh
REWIND_BENCH_SIZES=10,100,1000 REWIND_BENCH_FORCED=0 npm test -- --config vitest.perf.config.ts
REWIND_BENCH_SIZES=7400 REWIND_BENCH_FORCED=462 npm test -- --config vitest.perf.config.ts
REWIND_BENCH_SIZES=10000 REWIND_BENCH_FORCED=10000 npm test -- --config vitest.perf.config.ts
REWIND_BENCH_SIZES=7400 REWIND_BENCH_FORCED=462 REWIND_BENCH_MAX_MS=200 REWIND_BENCH_TRACE=1 npm test -- --config vitest.perf.config.ts
REWIND_BENCH_SIZES=10000 REWIND_BENCH_FORCED=10000 REWIND_BENCH_MAX_MS=200 REWIND_BENCH_TRACE=1 npm test -- --config vitest.perf.config.ts
```

Milliseconds; earlier builder normal runs (retained historical measurements):

| Files / forced tracked | Baseline unchanged median | Final cold | Final unchanged median | One-file edit samples | Force samples |
|---|---:|---:|---:|---|---|
| 10 / 0 | 140 | 200 | 94 | 141 / 148 / 209 | 100 / 147 / 82 |
| 100 / 0 | 126 | 266 | 87 | 172 / 148 / 169 | 86 / 95 / 87 |
| 1000 / 0 | 123 | 784 | 91 | 158 / 158 / 150 | 89 / 88 / 93 |
| 7400 / 462 | 111 | 5080 | 128 | 182 / 211 / 218 | 178 / 142 / 222 |
| 10000 / 10000 | 139 | 9064 | 141 | 253 / 241 / 336 | 117 / 112 / 120 |

Earlier builder diagnostic unchanged medians: **117 ms** representative (pass) and **218 ms** stress (**fail**, samples 217/244/218 ms). Cold times were 5733/11261 ms; full edit/force samples and Git traces are in `benchmarks.json`. Stable unchanged/force samples each retain one shadow `ls-files` walk. Stress unchanged samples have the same six subprocess calls as earlier runs; Git durations (roughly 25–53 ms per call) account for nearly all measured time, not newly introduced per-file Git work.

Earlier post-fix normal medians were 139/140/185/192/158 ms and 79/72/75/85/101 ms; earlier diagnostics **84/103 ms** passed. All samples/logs are retained. Latest load reached **47.11/22.89/12.64**, with another Node process at **416.2% CPU**, in `performance-investigation.log`. This explains a plausible contention contribution, not a proven causal attribution. These are **not controlled statistical comparisons or general speedup claims**. These earlier results do not settle the current diagnostic target. Baseline normal matrices were collected before edits; baseline threshold+trace variants were not.

### Fresh repair-run benchmarks

All five first repair matrices passed in `revision-bench-*.log`: ordinary medians **199/194/209 ms**, representative **224 ms**, stress **198 ms**, diagnostics **180/110 ms**. After the additional malformed/unreadable-ref fix and final check/build, all five commands were run again sequentially against the final source (`revision-release-bench-*.log`):

| Files / forced tracked | Cold ms | Unchanged median ms | One-file edit samples ms | Force samples ms | Exit |
|---|---:|---:|---|---|---:|
| 10 / 0 | 273 | 94 | 150 / 151 / 157 | 101 / 93 / 93 | 0 |
| 100 / 0 | 260 | 94 | 173 / 163 / 232 | 103 / 119 / 101 | 0 |
| 1000 / 0 | 801 | 94 | 201 / 242 / 173 | 93 / 95 / 91 | 0 |
| 7400 / 462 | 4488 | 109 | 177 / 179 / 214 | 154 / 130 / 115 | 0 |
| 10000 / 10000 | 6321 | 105 | 235 / 243 / 219 | 103 / 110 / 112 | 0 |
| 7400 / 462, 200-ms diagnostic | 6132 | **226** | 371 / 464 / 386 | 241 / 348 / 305 | **1** |
| 10000 / 10000, 200-ms diagnostic | 15174 | **258** | 508 / 475 / 455 | 317 / 290 / 262 | **1** |

Those first-repair diagnostics failed their unchanged-median 200-ms assertions (representative samples **179/226/384 ms**, stress **263/258/220 ms**). They were unresolved at that handoff; their failures remain recorded rather than replaced by later green runs. Fresh traces still show **six Git subprocess calls and one shadow `ls-files` walk** per unchanged sample, not new per-path work. Representative command durations reached 134 ms for `update-ref` and 100 ms for `rev-parse`; stress commands were 31–62 ms. HEAD queries run in parallel, so summed trace time is not wall time. Load averages during the final diagnostic runs ranged **11.34–17.96** (one-minute); the captured process snapshot included a VM at **253.4% CPU** and other concurrent work. This is evidence of contention, not proof that it alone caused the failures. No assertion was relaxed, skipped or rerun until green. Logs, full samples, traces and process observations are retained in `revision-benchmarks.json`, `revision-performance-traces.json` and `revision-performance-investigation.log`.

### Second repair-run benchmarks

All five existing matrices ran once, sequentially, against the final application source with unchanged assertions/config. All exited 0 (`repair2-bench-*.log`); complete samples/traces are in `repair2-benchmarks.json`.

| Files / forced tracked | Cold ms | Unchanged median ms | One-file edit samples ms | Force samples ms | Exit |
|---|---:|---:|---|---|---:|
| 10 / 0 | 259 | 116 | 177 / 195 / 184 | 133 / 150 / 109 | 0 |
| 100 / 0 | 310 | 108 | 186 / 172 / 183 | 120 / 132 / 118 | 0 |
| 1000 / 0 | 1274 | 121 | 209 / 244 / 227 | 111 / 121 / 123 | 0 |
| 7400 / 462 | 5802 | 141 | 170 / 174 / 177 | 103 / 132 / 106 | 0 |
| 10000 / 10000 | 17387 | 239 | 545 / 407 / 591 | 192 / 280 / 219 | 0 |
| 7400 / 462, 200-ms diagnostic | 6840 | **126** | 213 / 184 / 215 | 118 / 179 / 187 | 0 |
| 10000 / 10000, 200-ms diagnostic | 7687 | **116** | 244 / 276 / 314 | 132 / 130 / 151 | 0 |

Diagnostic unchanged samples were **172/126/111 ms** and **124/116/105 ms**. Traces retain six Git calls and one shadow index walk per unchanged capture. Normal stress median **239 ms** is slower than the previous **105 ms**, despite the later diagnostic **116 ms**. The normal matrix has no 200-ms assertion; this is not a failed diagnostic hidden as a pass. Recorded host load ranges **7.51–13.73** (one-minute), with other builds/tests and filesystem services busy (`repair2-performance-investigation.log`). The traced diagnostic cold `update-index` took **5762/5906 ms**, and Git dominates warm traces. This establishes variability/operation counts, not causal proof of contention or a general performance guarantee. No extra reruns to select green, weakened assertions, benchmark source changes or invented timings.

### Fresh captain benchmarks and stress investigation

The captain ran the existing ordinary matrix and both 200-ms diagnostics sequentially. The representative passed; the first stress diagnostic failed. An unchanged release archive was then verified against HEAD across **57 production/config/benchmark files** and used as a stress control. One fixed-source stress recheck followed. All logs and full samples are retained in `captain-verification.json`; no code, configuration or assertion changed between these runs.

| Source / files / forced tracked | Cold ms | Unchanged median ms | One-file edit samples ms | Force samples ms | Exit |
|---|---:|---:|---|---|---:|
| Fixed / 10 / 0 | 254 | 99 | 166 / 169 / 165 | 101 / 99 / 102 | 0 |
| Fixed / 100 / 0 | 300 | 103 | 169 / 202 / 172 | 99 / 97 / 99 | 0 |
| Fixed / 1000 / 0 | 789 | 101 | 183 / 166 / 172 | 107 / 109 / 101 | 0 |
| Fixed / 7400 / 462, diagnostic | 4984 | **115** | 186 / 202 / 225 | 146 / 148 / 126 | 0 |
| Fixed / 10000 / 10000, first diagnostic | 10534 | **294** | 517 / 537 / 558 | 279 / 271 / 212 | **1** |
| Release control / 10000 / 10000, diagnostic | 8755 | **169** | 342 / 391 / 593 | 233 / 168 / 165 | 0 |
| Fixed recheck / 10000 / 10000, diagnostic | 8641 | **139** | 257 / 265 / 266 | 163 / 131 / 139 | 0 |

The failed stress unchanged samples were **202/341/294 ms**; the recheck samples were **139/126/145 ms**. The failing run's traced Git calls commonly took 35–99 ms; the release control's unchanged calls took roughly 20–34 ms. Fixed-source unchanged traces retain **six Git calls and one shadow index walk**, versus seven calls/two walks in the release control. There is no renewed per-path Git subprocess loop.

Observed one-minute host load was **17.47** after the failure, **12.69** after the control, and **13.58/12.46** before/after the recheck. Other VM/build/load processes were active. These observations support timing variability but do not prove its cause. The runs were sequential on a changing shared host, not controlled statistical comparisons: **139 versus 169 ms is not a certified speedup**, and the earlier 294-ms failure remains a real miss. Latest diagnostics meet the unchanged-median target, not every sample, edited checkpoint or cold capture. No unrelated workload was interrupted.

## Limitations and justified deviations

- Final independent acceptance covers all seventeen findings, including repaired F01/F06. Latest captain representative/stress diagnostics pass at **115/139 ms**, but the first stress diagnostic failed at **294 ms** and earlier failures/slower normal results remain reported. Controlled-load performance reassessment is still valuable; no universal 200-ms or causal contention guarantee is claimed.
- Evidence is macOS/APFS, not a live Windows/remote-host run. No live restore/prune/gc/reload occurred; destructive tests used disposable fixtures only.
- SDK 0.5.9 frontend RPC has no transport-abort option. Stale UI responses are discarded; host-request cancellation is tested; unclaimed comparison handles expire. Crash-orphan pins are reclaimed on a later comparison or retention, not instantaneously at process death.
- Timeline/effect search bounds and capped listed output remain. Findings do not certify arbitrary history beyond those bounds or all pathological host/filesystem failures.
- Sequential red/green logs were kept while implementing; the structured ledger was assembled at completion rather than pre-created. Expanded policy/race matrices added after minimal fixes are labeled supplemental green evidence, not invented original reds. F09 intentionally uses source/work-bound red evidence rather than a timing assertion.
- Initial whole-suite verification exposed four compatibility/changed-policy expectations; subsequent fixes and updated safety expectations are documented in the ledger. Test setup errors are not presented as product reproductions.
- No project-checkout branch/worktree changes, commits/pushes/staging/stashing/resets, dependency/lock/version changes, installs, CI or plugin reload. Protected README/promotional work and historical measurements were not edited.

## Changed files

- Host/server entrypoints: `host.ts`, `server.ts`.
- Contracts/core: `src/host-contract.ts`, `src/rpc-contract.ts`, `src/service.ts`, `src/store.ts`, `src/retention.ts`.
- Host implementation: `src/host/handlers.ts`, `src/host/lock.ts`, `src/host/plan.ts`, `src/host/shadow.ts`, `src/host/user-repo.ts`.
- UI: `src/ui/FileDiffs.tsx`, `src/ui/Panel.tsx`, `src/ui/actions.tsx`, `src/ui/data.ts`.
- Tests: `test/app.test.tsx`, `test/helpers/world.ts`, `test/integration/host.test.ts`, `test/server.test.ts`, `test/unit/plan.test.ts`.
- Documentation: `docs/DESIGN.md`, `skills/rewind/SKILL.md`, this file. README/promotional diffs were pre-existing and remain protected.
