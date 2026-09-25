// Host RPC handlers. Kept apart from host.ts so tests can call them directly
// with a temporary data directory.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExperimentalHostRpcContext, ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import type { HostContract } from "../host-contract";
import { runGit } from "./git";
import { withLock } from "./lock";
import { directorySize, listShadowStates, Shadow, shadowsRoot } from "./shadow";

type Handlers = ExperimentalHostRpcHandlers<HostContract>;

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
    new Shadow(dataDirOf(context), workspace).skipPaths(excludePaths ?? []);

  return {
    snapshot: async (input, context) => {
      const shadow = shadowFor(context, input.workspace, input.excludePaths);
      return withLock(shadow.key, () =>
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
      return withLock(shadow.key, () => shadow.diff(input));
    },

    restore: async (input, context) => {
      const shadow = shadowFor(context, input.workspace, input.excludePaths);
      return withLock(shadow.key, () =>
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
      return withLock(shadow.key, () => shadow.refCommit(input.checkpointId));
    },

    deleteRefs: async (input, context) => {
      const shadow = shadowFor(context, input.workspace);
      return withLock(shadow.key, async () => ({ deleted: await shadow.deleteCheckpoints(input.checkpointIds) }));
    },

    reconcile: async (input, context) => {
      const shadow = shadowFor(context, input.workspace);
      const deletedRefs = await withLock(shadow.key, () =>
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
      return withLock(shadow.key, async () => {
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
}
