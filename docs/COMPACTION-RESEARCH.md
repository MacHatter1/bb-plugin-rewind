# Rewind storage research — 2026-10-20

The strongest next candidate is a **Rewind-owned object pool shared by
workspaces on the same host**. The current per-workspace repositories repeat
identical assets. A pool can remove those copies while keeping Git-based
diffs and restores. Content-defined chunking with Zstandard is a larger,
longer-term alternative for changed binary files.

## Evidence from this machine

Reclaim initially measured 8,512,684,032 allocated bytes for Rewind, including
8,457,515,008 bytes in its shadow stores. The remaining database and logs
are a small part of the total. There were 308 shadow repositories and
9,389 checkpoint refs.

The first packing-only pass completed without errors. Summed file lengths
fell from 8,310,433,739 to 8,202,845,278 bytes: 107,588,461 bytes saved.
These are logical file sizes, not refreshed Reclaim allocation measurements.
New checkpoints can also change these totals while a pass runs.

The subsequent aggressive pass completed all **308 stores without errors**.
Its per-store before/after measurements totaled 8,203,076,272 and
7,955,166,731 bytes: **247,909,541 bytes saved (about 3.02%)**. Together,
the two passes reported about 355 MB saved. These measurements reinforce
the case for cross-store deduplication rather than repeatedly recompressing
the same standalone packs.

A fresh Reclaim scan after the work measured **8,030,142,464 allocated bytes**
for Rewind, 482,541,568 fewer than the initial scan. This allocation comparison
also spans other active threads and checkpoint lifecycle activity; it is
separate from the compaction command's summed logical-file measurements.

Post-pass verification ran full `git fsck` on all 308 stores successfully and
confirmed that all 515,769 original object copies remained readable. Of the
9,389 original checkpoint refs, 87 were absent; every one also lacked its
checkpoint database row. Other threads and normal checkpoint cleanup remained
active throughout the run. The compaction path only repacks objects and has no
ref or database-row deletion operation. The live all-refs comparison therefore
did not pass, although no original object was lost. Controlled integration tests
verify that compaction preserves every ref and object, including unreachable
objects, and restores still work afterward. The final project check passed
293 tests with one existing filesystem-dependent skip.

An object-ID inventory found:

| Measurement | Result |
| --- | ---: |
| Object copies across repositories | 515,769 |
| Distinct object IDs | 277,701 |
| Redundant object copies across repositories | 238,068 |
| Object IDs appearing in multiple repositories | 42,504 |
| Maximum repositories containing one object | 195 |

A subsequent read-only scan used `git cat-file --batch-all-objects` with
`objectsize:disk`. For each repeated blob, it summed its stored representations
and subtracted its largest representation once. That produced **2,525,553,529
bytes of overlapping blob representations**. This is an opportunity metric,
not a forecast of bytes a pool will reclaim: pack delta dependencies, new
delta choices, indexes, and concurrent activity affect the final result.

Examples include a 2.37 MB MP4 present in 18 stores and several 3–5 MB images
present in eight stores. Deduplication can help identical compressed media
even when another compression pass cannot shrink each copy.

## Methods compared

| Method | What it can improve | Fit for Rewind |
| --- | --- | --- |
| Shared Git object pool | Identical objects across workspace stores; potentially better deltas in the combined pool | Best next implementation. Retains the Git engine, but needs central object lifetime management. [GitLab's implementation](https://docs.gitlab.com/development/git_object_deduplication/) demonstrates this pattern. |
| Content-defined chunks plus Zstandard | Repeated sections of changed large files, and duplicates across snapshots/workspaces | Promising for a future storage backend. [Kopia](https://kopia.io/docs/features/) and [Borg](https://borgbackup.readthedocs.io/en/stable/internals/data-structures.html) split data into chunks and deduplicate before compression. Requires new manifests, indexing, restore logic and garbage collection. |
| Path-aware Git packing | Poor delta matches caused by similar names in different directories | Worth a controlled benchmark on the build-heavy store. Git offers [`--path-walk` and `--name-hash-version=2`](https://git-scm.com/docs/git-pack-objects). This machine's Git 2.54 advertises both; other hosts need capability checks. No real-store saving has been measured for these flags yet. |
| Geometric/incremental repacking | Repeatedly rewriting large packs as small amounts of new data arrive | Mainly reduces compaction work and write amplification. [Git's geometric repack](https://git-scm.com/docs/git-repack) selects a subset of packs to combine. Most of these stores already had one pack, so this is not the main current space opportunity. |
| Zstandard or XZ around existing packs | Residual redundancy left in already-compressed packs | Small gains in the samples below. A cold archive/cache layer would be needed before ordinary Git access. |
| Grouped cold archives with long-distance compression | Repeated pack bytes across multiple archived workspaces | Could also exploit cross-store repetition. Not benchmarked here; whole-group extraction and a larger decode window add warm-up and memory costs. [Zstd documents](https://github.com/facebook/zstd/blob/dev/programs/zstd.1.md) the matching-window/decompression-memory relationship. |
| APFS clones or transparent filesystem compression | Shared blocks between deliberate copies, or extra platform-level compression | Useful as a Mac-specific optimization, not the main cross-platform storage design. [Apple documents](https://developer.apple.com/documentation/foundation/about-apple-file-system) that clones share unchanged blocks; independently rewritten Git packs do not automatically gain cross-store deduplication. |
| SQLite `VACUUM` | Unused pages in Rewind's metadata database | A read-only PRAGMA check found 5,255 free 4 KiB pages (21,524,480 bytes) in a 48,480,256-byte database. [SQLite documents](https://sqlite.org/lang_vacuum.html) rebuilding the database to reclaim unused space. A useful small cleanup, but much less than the object-store overlap; it needs coordination with database writes. No vacuum was run. |

Git's own documentation notes that [aggressive GC can cost much more CPU
without a worthwhile space improvement](https://git-scm.com/docs/git-gc).
That is a reason to measure structural deduplication rather than assume a
wider delta window will recover gigabytes.

## Local experiments

### Stronger Git packing of a whole existing store

A temporary APFS-cloned copy of the build-heavy store was repacked with
level 9, `-F`, a 50-object window, two threads and 64 MiB of window memory
per thread. Git's pack-size count fell from 1,404,471 to 1,370,318 KiB:
34,972,672 bytes, or about 2.43%. Repacking and verification took 390,906 ms.
All refs and object IDs were identical and full `git fsck` succeeded.
The temporary copy was removed. This trial predates the stronger live
250-object / 256 MiB profile; its result does not predict that profile's saving.

In the subsequent live 250-object / 256 MiB pass, the largest media-heavy
store fell from 1,644,847 to 1,644,590 KiB of packed storage: **263,168 bytes
saved, about 0.016%**. Its compression process was observed still working
after 19 minutes 32 seconds and subsequently completed. This is a particularly
poor fit for repeatedly recomputing deltas. Daily cleanup therefore applies
strong settings to new data while reusing existing packed data; the explicit
compaction command still offers full aggressive recompression.

### Compressing existing pack bytes with another codec

Two samples were taken in memory: the first 32 MiB of one media-heavy pack
and one build/source-heavy pack. Each output was decompressed and its SHA-256
checked against the input. These samples do not represent entire repositories.

| Sample | Codec | Input bytes | Output bytes | Saved | Encode / decode |
| --- | --- | ---: | ---: | ---: | --- |
| Media-heavy | Zstd 19, long window | 33,554,432 | 33,530,269 | 0.072% | 4.601 s / 0.014 s |
| Media-heavy | XZ 9e | 33,554,432 | 33,542,804 | 0.035% | 6.484 s / 0.067 s |
| Build/source-heavy | Zstd 19, long window | 33,554,432 | 32,909,161 | 1.923% | 4.886 s / 0.014 s |
| Build/source-heavy | XZ 9e | 33,554,432 | 32,882,760 | 2.002% | 6.738 s / 0.650 s |

The test used Zstd 1.5.7 and XZ 5.8.4. Wrapping a Git pack is different from
using Zstd on original chunks: Git has already applied compression and deltas.
Zstd's [long-distance matching](https://github.com/facebook/zstd/blob/dev/programs/README.md)
can find distant matches, but it cannot create a cross-workspace object pool.

### Disposable shared-pool prototype

Two synthetic repositories each contained eight shared 256 KiB blobs and
one unique 256 KiB blob. A separate pool fetched both repositories' refs,
then each participant used an alternates link and a local repack.

Combined Git object storage fell from **4,722,688 to 2,623,488 bytes**, about
44.45%. Every repository passed full `git fsck`. After both workspace
directories and one participant repository were removed, the other participant
still read the original shared bytes correctly from the pool.

This proves the basic mechanism on disposable synthetic data. It is not a
production migration or a 44% prediction for the real stores. That experiment
connected only disposable synthetic repositories.

### Two related real workspace stores

The same mechanism was then tested on temporary local copies of two existing
BB workspace shadow repositories sharing 8,757 object IDs. Their combined Git
object-storage count fell from **58,292,224 to 29,858,816 bytes**: 28,433,408
bytes saved, about **48.78%**. The pool accounted for 29,819,904 bytes and the
remaining participant-local objects were retained separately.

Every checkpoint ref and original object remained readable. Full `git fsck`
passed for both participants and passed again for the remaining participant
after the other copy was removed. The temporary copies and pool were deleted;
live stores were not linked to that pool. Counts use Git's KiB storage totals,
so they are rounded object-storage footprints, not APFS allocation measurements.
This real pair validates the deduplication opportunity for closely related
workspaces, but its percentage is not a forecast for all 308 stores.

## Implemented shared-pool design

The `bb rewind pool` command now implements opt-in migration and
`bb rewind pool --gc` implements coordinated collection. The prototype numbers
above remain experiment results, not a forecast for a whole-host migration.
The implementation copies objects first, verifies the complete pool and
original object inventory, journals each participant, and removes duplicate
local objects only after installing a verified alternates link. New snapshots
continue writing locally. A rerun resumes incomplete migrations.

An exclusive host gate drains all Git readers/writers before pool maintenance.
GC inventories every registered member and checks for unregistered borrowers.
It pins all refs plus index, detached HEAD and cached-state roots; retired roots
are retained for at least two hours. Complete pool `fsck` verifies stored bytes,
and each member's full ref closure is checked without repeatedly scanning all
other members' blobs. Uncertain metadata stops collection. Daily retention
invokes this coordinator once per host, after local reconciliation/removal.

Durable copies and metadata writes precede local cleanup. A persistent
maintenance lock prevents a replacement worker from using stores after a hard
crash while an orphaned Git process may still be active. Handled failures release
the lock and retain a resumable member journal. Maintenance intentionally pauses
Rewind operations on that host; large pools should be migrated during a quiet
period. See README for commands, backup boundaries and crash-lock recovery.

### Live rollout and verification

The installed implementation was first exercised on the two related BB stores
used by the real-copy prototype. Migration, coordinated GC, full participant
`fsck`, and a historical CLI diff all succeeded. All 850 original refs and
20,051 original object copies remained readable. Adding the second store
reported 28,461,677 bytes saved through sharing.

The subsequent whole-host migration processed **311 stores** (309 newly
migrated plus the two canaries), reporting **7,927,281,163 → 5,382,584,337
logical bytes**, a reduction of **2,544,696,826 bytes, about 32.10%**. No store
reported an error. Coordinated GC then completed across all 311 members,
ending at 5,383,628,156 logical bytes including its updated metadata.

An independent post-GC check compared the saved pre-migration inventory with
the live pool and participants. It verified all **9,457 original refs** and
**515,949 original object copies**, with no missing objects, missing active
checkpoint refs, concurrent ref removals, or integrity errors. The pool held
277,854 distinct objects. Full pool `git fsck`, every member's ref closure,
and a historical CLI diff succeeded after GC. The final project check passed
**309 tests with one existing filesystem-dependent skip**; the plugin build
also passed. These are live local results, not cross-platform performance claims.

The refreshed Reclaim allocation scan measured **5,468,024,832 bytes** for the
entire Rewind directory, including **5,412,806,656 bytes** in host data. The
earlier post-compression scan measured 8,030,142,464 bytes for Rewind: the
directory now occupies **2,562,117,632 fewer allocated bytes**. This allocation
comparison spans ongoing machine activity; the command's logical-byte results
above describe its own measured before/after totals.

### Design constraints

Keep each workspace's index and checkpoint identity, with a host-local pool
owned entirely by Rewind. Never borrow objects from a user's repository.
Copy objects and pin checkpoint, comparison, import and Undo roots before
switching any participant to the pool. Verify old snapshots before reclaiming
duplicate local copies, and journal migration so interruption preserves a
readable representation.

Participant repacking must use `--local`. The current standalone compaction
path would otherwise copy borrowed pool objects back into each workspace's
repository and undo the saving. The disposable prototype explicitly used
local repacking; the implemented participant compaction and cleanup paths also
use local repacking once a store is pooled.

Object lifetime must be decided across all participants. Ordinary per-store
GC must not prune the pool: [Git warns](https://git-scm.com/docs/git-clone)
that deleting borrowed objects can corrupt dependents. A Rewind implementation
needs a complete root inventory, active-operation pins, a grace period, and
failure handling that retains data when ownership is uncertain. Deleting a
workspace must not remove objects another workspace still needs.

Benchmark real space, capture p50/p95, historical diffs, and restore latency
before choosing this as the default. Cover concurrent snapshots, Undo,
comparison pins, crashes during migration, unavailable pools, and removal
of one participant. Do not introduce lossy media re-encoding or discard
checkpoint history as part of compaction.
