// Rewind — backend entry. Wires the service (src/service.ts) to BB: the
// message.dispatch gate, thread lifecycle events, RPC for the app, the
// `bb rewind` CLI, agent tools, and the daily retention schedule. Git work
// runs on the thread's machine through the host entry (host.ts).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildCli } from "./src/cli";
import { CHANGED_CHANNEL, GATE_HARD_LIMIT_MS } from "./src/constants";
import { hostContract } from "./src/host-contract";
import { rpcContract } from "./src/rpc-contract";
import { RewindError, RewindService, toCheckpointDto } from "./src/service";
import { normalizeSettings, settingsDescriptors, type RewindSettings } from "./src/settings";
import { MIGRATIONS, RewindStore } from "./src/store";
import { registerTools } from "./src/tools";

export type { RpcContract } from "./src/rpc-contract";

function rpcError(error: unknown): never {
  if (error instanceof RewindError) throw new Error(error.hint === undefined ? error.message : `${error.message} ${error.hint}`);
  throw error;
}

export default async function plugin(bb: BbPluginApi) {
  const settingsHandle = bb.settings.define(settingsDescriptors);
  let settings: RewindSettings = normalizeSettings(await settingsHandle.get());
  settingsHandle.onChange((next) => {
    settings = normalizeSettings(next);
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = new RewindStore(db);
  const loadedAt = Date.now();
  // Snapshots a previous load started can no longer report back.
  store.failStalePending(loadedAt, loadedAt);
  store.failInterruptedForks(loadedAt);

  const host = bb.hosts.experimental_client({ contract: hostContract });
  const service = new RewindService({
    sdk: () => bb.sdk,
    host,
    store,
    settings: () => settings,
    log: bb.log,
    publish: (threadId) => bb.realtime.publish(CHANGED_CHANNEL, { threadId }),
    recheck: () => bb.experimental_hooks.recheck("message.dispatch"),
  });

  // Before every message: hold it briefly for its checkpoint, or queue it
  // until the checkpoint is saved. onDispatch never throws; the race is a
  // last guard against a hung call, and anything unexpected proceeds.
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        service.onDispatch(ctx),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), GATE_HARD_LIMIT_MS);
        }),
      ]);
      return result?.decision ?? { action: "proceed" };
    } catch (error) {
      bb.log.warn(`dispatch gate error (message sent anyway): ${error instanceof Error ? error.message : String(error)}`);
      return { action: "proceed" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });

  const logFailure = (what: string) => (error: unknown) => {
    bb.log.warn(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  };
  bb.events.on("thread.active", ({ thread }) => service.onThreadActive(thread).then(() => undefined, logFailure("baseline checkpoint")));
  bb.events.on("thread.idle", ({ thread }) => service.onTurnEnded(thread).then(() => undefined, logFailure("after-turn checkpoint")));
  bb.events.on("thread.failed", ({ thread }) => service.onTurnEnded(thread).then(() => undefined, logFailure("after-turn checkpoint")));
  bb.events.on("thread.deleted", ({ thread }) => service.onThreadDeleted(thread.id).then(() => undefined, logFailure("checkpoint cleanup")));
  bb.events.on("message.queued", ({ entry }) => service.onMessageQueued(entry));
  bb.events.on("message.dispatched", ({ entry }) => service.onMessageDispatched(entry));
  bb.events.on("message.cancelled", ({ entry }) => service.onMessageCancelled(entry));

  bb.rpc.register(
    rpcContract,
    {
      summary: ({ threadId }) => service.summary(threadId),
      list: ({ threadId, limit }) => service.list(threadId, limit).catch(rpcError),
      resolveMessage: ({ threadId, message }) => service.resolveMessage(threadId, message).catch(rpcError),
      preview: ({ threadId, checkpointId }) => service.preview(threadId, checkpointId).catch(rpcError),
      diff: (input) => service.diff(input).catch(rpcError),
      restore: ({ threadId, checkpointId }) => service.restore(threadId, checkpointId).catch(rpcError),
      editMessage: (input) => service.editMessage(input).catch(rpcError),
      note: ({ threadId }) => ({ note: service.note(threadId) }),
      dismissNote: ({ threadId }) => ({ dismissed: service.dismissNote(threadId) }),
      undo: ({ threadId, restoreId }) => service.undo(threadId, restoreId).catch(rpcError),
      checkpoint: async ({ threadId, label }) => ({ checkpoint: toCheckpointDto(await service.checkpointNow(threadId, label ?? null).catch(rpcError)) }),
      fork: async (input) => ({ job: await service.fork(input).catch(rpcError) }),
      forkStatus: ({ jobId }) => {
        try {
          return { job: service.forkStatus(jobId) };
        } catch (error) {
          return rpcError(error);
        }
      },
      stopRunning: async ({ threadId }) => ({ stopped: await service.stopRunning(threadId).catch(rpcError) }),
      status: () => service.status(),
    },
    { experimental_discoverable: true, experimental_description: "Rewind: workspace checkpoints, restores, and forks with files." },
  );

  bb.cli.register(buildCli({ service, store, sdk: () => bb.sdk }));
  registerTools(bb.agents, service);

  // Daily at 03:17 server time: retention, ref reconciliation, gc.
  bb.background.schedule("retention", "17 3 * * *", async () => {
    const result = await service.retention({ dryRun: false });
    bb.log.info(`retention: deleted ${result.deleted} checkpoints, ${result.refsDeleted} refs, ${result.shadowsRemoved} stores`);
  });

  bb.onDispose(async () => {
    await service.dispose();
  });

  // Messages a previous load queued are still waiting: re-attempt them now.
  // Their snapshots died with that load, so each one proceeds.
  void bb.experimental_hooks.recheck("message.dispatch").catch(logFailure("re-sending queued messages"));
}
