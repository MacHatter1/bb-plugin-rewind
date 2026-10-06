// Host RPC handlers. Kept apart from host.ts so tests can call them directly
// with a temporary data directory.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExperimentalHostRpcContext, ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import type { HostContract, SkippedFile } from "../host-contract";
import { runGit } from "./git";
import { withLock, workspaceIdentity } from "./lock";
import { directorySize, listShadowStates, Shadow, shadowsRoot } from "./shadow";

async function lockKey(shadow: Shadow): Promise<string> {
  try { return (await workspaceIdentity(shadow.workspace)).identity; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return shadow.key;
    throw error;
  }
}

type Handlers = ExperimentalHostRpcHandlers<HostContract>;
const disposers = new WeakMap<Handlers, () => Promise<void>>();
export async function disposeHostHandlers(handlers: Handlers): Promise<void> { await disposers.get(handlers)?.(); }

let gitVersion: Promise<string | null> | null = null;

function readGitVersion(cwd: string): Promise<string | null> {
  gitVersion ??= runGit(["--version"], { cwd, timeoutMs: 10_000 }).then(
    (result) => result.stdout.toString("utf8").trim(),
    () => {
      gitVersion = null;
      return null;
    },
  );
  return gitVersion;
}

/** `dataDirOverride` lets tests run the handlers against a temp directory. */
export function createHostHandlers(dataDirOverride?: string): Handlers {
  const dataDirOf = (context: ExperimentalHostRpcContext) => dataDirOverride ?? context.experimental_paths.dataDir;
  const shadowFor = (context: ExperimentalHostRpcContext, workspace: string, excludePaths?: readonly string[]) =>
    new Shadow(dataDirOf(context), workspace, Date.now, context.signal).skipPaths(excludePaths ?? []);

  type Comparison = { workspace: string; signature: string; shadow: Shadow; key: string; from: string; to: string; skipped: SkippedFile[]; expires: number; timer: ReturnType<typeof setTimeout> };
  const comparisons = new Map<string, Comparison>();
  const release = async (id: string): Promise<boolean> => {
    const entry = comparisons.get(id);
    if (entry === undefined) return false;
    comparisons.delete(id); clearTimeout(entry.timer);
    await withLock(entry.key, () => entry.shadow.bare(["update-ref", "--stdin"], { input: `delete refs/rewind-comparison/${id}/from\ndelete refs/rewind-comparison/${id}/to\n` }));
    return true;
  };
  const handlers: Handlers = {
    identity: async (input) => workspaceIdentity(input.workspace),
    snapshot: async (input, context) => {
      const shadow = shadowFor(context, input.workspace, input.excludePaths);
      return withLock(await lockKey(shadow), () =>
        shadow.snapshot({
          checkpointId: input.checkpointId,
          subject: input.subject,
          compareTo: input.compareTo,
          limits: input.limits,
          force: input.force,
          signal: context.signal,
        }),
      );
    },

    diff: async (input, context) => {
      const shadow = shadowFor(context, input.workspace, input.excludePaths);
      const key = await lockKey(shadow);
      const signature = JSON.stringify([input.from, input.to, input.limits, input.excludePaths ?? []]);
      const cached = input.comparison === undefined ? undefined : comparisons.get(input.comparison);
      if (input.comparison !== undefined && (cached === undefined || cached.workspace !== input.workspace || cached.shadow.root !== shadow.root || cached.signature !== signature || cached.expires <= Date.now())) {
        if (cached !== undefined && cached.expires <= Date.now()) await release(input.comparison);
        return { status: "unavailable", reason: "This comparison expired or belongs to another workspace/request. Refresh the comparison." };
      }
      // Eviction is outside the lock: releasing pins takes that same workspace lock.
      if (cached === undefined && comparisons.size >= 32) await release(comparisons.keys().next().value!);
      return withLock(key, async () => {
        const result = await shadow.diff(input, cached);
        if (result.status !== "ok") return result;
        if (cached !== undefined) return { ...result, comparison: input.comparison! };
        if (input.paths !== null || (input.from.kind !== "workspace" && input.to.kind !== "workspace")) return result;
        // Cold-worker leftovers have no usable handle. Remove their pins before allocating another.
        const refs = (await shadow.bare(["for-each-ref", "--format=%(refname)", "refs/rewind-comparison/"])).stdout.toString("utf8").trim().split("\n");
        const stale = refs.filter(ref => ref !== "" && !comparisons.has(ref.split("/")[2]!));
        if (stale.length > 0) await shadow.bare(["update-ref", "--stdin"], { input: stale.map(ref => `delete ${ref}\n`).join("") });
        if (comparisons.size >= 32) return { status: "unavailable", reason: "Too many active comparisons; close or refresh a comparison." };
        const id = `${Date.now()}-${randomUUID()}`;
        const timer = setTimeout(() => { void release(id).catch(() => undefined); }, 120_000); timer.unref();
        // Reserve synchronously so simultaneous workspace calls cannot exceed the cap.
        comparisons.set(id, { workspace: input.workspace, signature, shadow: new Shadow(dataDirOf(context), input.workspace), key, from: result.fromTree, to: result.toTree, skipped: result.skipped, expires: Date.now() + 120_000, timer });
        try {
          await shadow.bare(["update-ref", "--stdin"], { input: `update refs/rewind-comparison/${id}/from ${result.fromTree}\nupdate refs/rewind-comparison/${id}/to ${result.toTree}\n` });
        } catch (error) {
          comparisons.delete(id); clearTimeout(timer);
          await new Shadow(dataDirOf(context), input.workspace).bare(["update-ref", "--stdin"], { input: `delete refs/rewind-comparison/${id}/from\ndelete refs/rewind-comparison/${id}/to\n` }).catch(() => undefined);
          throw error;
        }
        return { ...result, comparison: id };
      }, context.signal);
    },

    releaseComparison: async (input) => {
      const entry = comparisons.get(input.comparison);
      if (entry === undefined || entry.workspace !== input.workspace) return { released: false };
      return { released: await release(input.comparison) };
    },

    restore: async (input, context) => {
      const shadow = shadowFor(context, input.workspace, input.excludePaths);
      return withLock(await lockKey(shadow), () =>
        shadow.restore({
          target: input.target,
          dryRun: input.dryRun,
          preRestore: input.preRestore,
          limits: input.limits,
          maxListed: input.maxListed,
          signal: context.signal,
        }),
      );
    },

    refCommit: async (input, context) => {
      const shadow = shadowFor(context, input.workspace);
      return withLock(await lockKey(shadow), () => shadow.refCommit(input.checkpointId));
    },

    deleteRefs: async (input, context) => {
      const shadow = shadowFor(context, input.workspace);
      return withLock(await lockKey(shadow), async () => ({ deleted: await shadow.deleteCheckpoints(input.checkpointIds) }));
    },

    reconcile: async (input, context) => {
      const shadow = shadowFor(context, input.workspace);
      const deletedRefs = await withLock(await lockKey(shadow), () =>
        shadow.deleteUnknownRefs(new Set(input.keepCheckpointIds), input.minAgeMs),
      );
      // gc runs outside the lock: its prune grace period keeps objects a
      // concurrent snapshot is still writing, and holding the lock for a long
      // repack would make that workspace's messages wait on it.
      let gcRan = false;
      if (input.gc && (await shadow.exists())) {
        await shadow.gc();
        gcRan = true;
      }
      return { deletedRefs, gcRan, sizeBytes: gcRan ? await directorySize(shadow.root) : null };
    },

    listShadows: async (_input, context) => {
      const states = await listShadowStates(dataDirOf(context));
      return {
        shadows: states.map(({ key, state }) => ({
          key,
          workspace: state?.workspace ?? "",
          lastUsedAt: typeof state?.lastUsedAt === "number" ? state.lastUsedAt : null,
          refCount: null,
        })),
      };
    },

    removeShadow: async (input, context) => {
      const root = path.join(shadowsRoot(dataDirOf(context)), input.key);
      return withLock(input.key, async () => {
        const existed = (await listShadowStates(dataDirOf(context))).some((entry) => entry.key === input.key);
        await rm(root, { recursive: true, force: true });
        return { removed: existed };
      });
    },

    status: async (input, context) => {
      const shadow = shadowFor(context, input.workspace);
      return withLock(await lockKey(shadow), async () => {
        const shadowExists = await shadow.exists();
        const state = shadowExists ? await shadow.loadState() : null;
        const unsupported =
          state?.unsupported && state.unsupported.until > Date.now()
            ? { reason: state.unsupported.reason, until: state.unsupported.until }
            : null;
        return {
          workspaceExists: await shadow.workspaceExists(),
          shadowExists,
          unsupported,
          lastSnapshotAt: state?.lastSnapshotAt ?? null,
          refCount: await shadow.refCount(),
          sizeBytes: input.measureSize && shadowExists ? await directorySize(shadow.root) : null,
          gitVersion: await readGitVersion(os.tmpdir()),
        };
      });
    },
  };
  disposers.set(handlers, async () => { await Promise.allSettled([...comparisons.keys()].map(release)); });
  return handlers;
}
