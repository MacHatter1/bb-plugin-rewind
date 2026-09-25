// `bb rewind …` — declared with defineCli so every command gets --help, typo
// suggestions, and the --json error envelope. Output is bounded.
import path from "node:path";
import { PluginCliError, cliCommand, defineCli, type PluginBbSdk, type PluginCliContext, type PluginCliRegistration, type PluginCliResult } from "@get-bb/plugin-sdk";
import { CHECKPOINT_ID_PATTERN, RESTORE_ID_PATTERN, THREAD_ID_PATTERN } from "./ids";
import {
  OUTPUT_BUDGET_BYTES,
  capOutput,
  formatDiffPatch,
  formatDiffStat,
  formatEditResult,
  formatForkJob,
  formatList,
  formatPreview,
  formatRestoreOutcome,
  formatShow,
  formatTime,
  plural,
  statsLabel,
} from "./format";
import { RewindError, type RewindService, toCheckpointDto } from "./service";
import type { RewindStore } from "./store";

const threadOption = {
  type: "string",
  description: "Thread id (thr_…). Defaults to the thread running the command.",
  aliases: ["thread-id"],
  placeholder: "thr_…",
} as const;
const jsonOption = { type: "boolean", description: "Print machine-readable JSON" } as const;

interface CliDeps {
  service: RewindService;
  store: RewindStore;
  sdk: () => PluginBbSdk;
}

function text(stdout: string): PluginCliResult {
  return { exitCode: 0, stdout: capOutput(stdout.endsWith("\n") ? stdout : `${stdout}\n`) };
}

function json(value: unknown): PluginCliResult {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > OUTPUT_BUDGET_BYTES) {
    throw new PluginCliError("The JSON output is too large for one CLI response.", {
      code: "output_too_large",
      hint: "Ask for less: lower --limit, pass --path, or use --stat.",
    });
  }
  return { exitCode: 0, stdout: body };
}

function asCliError(error: unknown): never {
  if (error instanceof PluginCliError) throw error;
  if (error instanceof RewindError) throw new PluginCliError(error.message, { code: error.code, ...(error.hint === undefined ? {} : { hint: error.hint }) });
  throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "rewind_failed" });
}

async function guard(run: () => Promise<PluginCliResult>): Promise<PluginCliResult> {
  try {
    return await run();
  } catch (error) {
    return asCliError(error);
  }
}

/**
 * An agent running `bb rewind restore` from inside its own turn is always
 * refused (its thread is running), and stopping itself is never the answer.
 */
async function refuseSelfRestore(service: RewindService, threadId: string, ctx: PluginCliContext, command: string): Promise<void> {
  if (ctx.threadId !== threadId) return;
  const { workspace } = await service.resolveWorkspace(threadId);
  const running = await service.runningThreads(workspace.environmentId, threadId);
  if (!running.some((thread) => thread.isSelf)) return;
  throw new PluginCliError("This thread is running, so its workspace cannot be restored from inside its own turn.", {
    code: "thread_running",
    hint: `Tell the user the checkpoint id instead: they can restore it from the Checkpoints panel, or run \`bb rewind ${command} --thread ${threadId}\` in a terminal once this turn ends. \`--dry-run\` shows what would change.`,
  });
}

function threadFor(option: string | undefined, ctx: PluginCliContext, command: string): string {
  const threadId = option ?? ctx.threadId;
  if (threadId === undefined || threadId.length === 0) {
    throw new PluginCliError("No thread to work on: this command is not running inside a BB thread.", {
      code: "missing_thread",
      hint: `Pass --thread <thread-id>, for example \`bb rewind ${command} --thread thr_…\`. \`bb thread list\` shows thread ids.`,
    });
  }
  if (!THREAD_ID_PATTERN.test(threadId)) {
    throw new PluginCliError(`"${threadId}" is not a thread id.`, { code: "invalid_thread", hint: "Thread ids look like thr_abc123." });
  }
  return threadId;
}

export function buildCli(deps: CliDeps): PluginCliRegistration {
  const { service, store } = deps;

  /** Exact id, or a unique prefix among the thread's checkpoints. */
  const checkpointFor = (value: string, threadId: string | null): string => {
    if (CHECKPOINT_ID_PATTERN.test(value) && store.getCheckpoint(value) !== null) return value;
    const needle = value.startsWith("ck_") ? value : `ck_${value}`;
    const candidates = threadId === null ? [] : store.listCheckpoints(threadId).filter((row) => row.id.startsWith(needle));
    if (candidates.length === 1) return candidates[0]!.id;
    if (candidates.length > 1) {
      throw new PluginCliError(`"${value}" matches ${candidates.length} checkpoints.`, { code: "ambiguous_checkpoint", hint: "Use more characters of the id." });
    }
    throw new PluginCliError(`Checkpoint "${value}" was not found${threadId === null ? "" : ` for ${threadId}`}.`, {
      code: "checkpoint_not_found",
      hint: "Run `bb rewind list` to see checkpoint ids.",
    });
  };

  const optionalThread = (option: string | undefined, ctx: PluginCliContext): string | null => {
    const threadId = option ?? ctx.threadId;
    return threadId !== undefined && THREAD_ID_PATTERN.test(threadId) ? threadId : null;
  };

  const readPromptFile = async (file: string, threadId: string | null, ctx: PluginCliContext): Promise<string> => {
    // The file lives on the machine that ran the command, not on the server.
    const absolute = path.isAbsolute(file) ? file : ctx.cwd === undefined ? null : path.resolve(ctx.cwd, file);
    if (absolute === null) {
      throw new PluginCliError(`Cannot resolve "${file}" without a working directory.`, { code: "invalid_value", hint: "Pass an absolute path." });
    }
    let hostId: string | undefined;
    if (threadId !== null) {
      try {
        hostId = (await service.resolveWorkspace(threadId)).workspace.hostId;
      } catch {
        hostId = undefined;
      }
    }
    const read = await deps.sdk().files.read({ path: absolute, ...(hostId === undefined ? {} : { hostId }) });
    if (read.sizeBytes > 100_000) throw new PluginCliError("The prompt file is larger than 100 KB.", { code: "invalid_value" });
    return read.contentEncoding === "base64" ? Buffer.from(read.content, "base64").toString("utf8") : read.content;
  };

  return defineCli({
    name: "rewind",
    summary: "Checkpoints of a thread's workspace: list, diff, restore, undo, and fork with files",
    description:
      "Rewind snapshots each thread's workspace before and after every turn. Restores take an undo point first and never touch ignored files, files over the size cap, or .git. Thread-scoped commands default to the calling thread.",
    commands: {
      list: cliCommand({
        summary: "List the thread's checkpoints, newest turn first",
        options: {
          thread: threadOption,
          limit: { type: "integer", min: 1, max: 1_000, default: 200, description: "How many recent checkpoints to show (1-1000)" },
          json: jsonOption,
        },
        run: (input, ctx) =>
          guard(async () => {
            const threadId = threadFor(input.options.thread, ctx, "list");
            const listed = await service.list(threadId, input.options.limit);
            if (input.options.json) {
              return json({
                threadId,
                workspace: listed.workspace,
                workspaceError: listed.workspaceError,
                settings: listed.settings,
                // Per-file lists stay out of the list view; `show` has them.
                checkpoints: listed.checkpoints.map((checkpoint) => ({ ...checkpoint, changes: [], changesTruncated: checkpoint.changes.length > 0 || checkpoint.changesTruncated })),
                restores: listed.restores,
              });
            }
            let body = formatList({ threadId, checkpoints: listed.checkpoints, restores: listed.restores, workspace: listed.workspace });
            if (listed.workspaceError !== null) body += `\n\nWorkspace: ${listed.workspaceError}`;
            if (!listed.settings.enabled) body += "\n\nAutomatic checkpoints are off (plugin setting `enabled`).";
            return text(body);
          }),
      }),

      show: cliCommand({
        summary: "Show one checkpoint: what it captured, what changed, what was skipped",
        positionals: [{ name: "checkpoint", description: "Checkpoint id (ck_…) or a unique prefix", required: true }],
        options: { thread: threadOption, json: jsonOption },
        run: (input, ctx) =>
          guard(async () => {
            const id = checkpointFor(input.positionals.checkpoint, optionalThread(input.options.thread, ctx));
            const row = store.getCheckpoint(id)!;
            return input.options.json ? json(toCheckpointDto(row)) : text(formatShow(toCheckpointDto(row)));
          }),
      }),

      diff: cliCommand({
        summary: "Show what a checkpoint's turn changed, or what changed since it",
        description:
          "By default compares the checkpoint with the thread's previous checkpoint (what that turn changed). --to current compares it with the files now (what a restore would undo). Patches are capped per file and in total.",
        positionals: [{ name: "checkpoint", description: "Checkpoint id (ck_…) or a unique prefix", required: true }],
        options: {
          from: { type: "string", description: "Compare from this checkpoint instead of the previous one", placeholder: "ck_…" },
          to: { type: "string", description: "Compare to this checkpoint, or `current` for the workspace now", placeholder: "ck_…|current" },
          stat: { type: "boolean", description: "Only list files with added/removed line counts" },
          path: { type: "string", repeatable: true, description: "Limit to these workspace-relative paths (repeatable, max 50)" },
          thread: threadOption,
          json: jsonOption,
        },
        run: (input, ctx) =>
          guard(async () => {
            const threadHint = optionalThread(input.options.thread, ctx);
            const id = checkpointFor(input.positionals.checkpoint, threadHint);
            const checkpoint = store.getCheckpoint(id)!;
            let from: string;
            let to: string;
            if (input.options.to === "current") {
              from = input.options.from === undefined ? id : checkpointFor(input.options.from, checkpoint.threadId);
              to = "current";
            } else if (input.options.to !== undefined) {
              from = id;
              to = checkpointFor(input.options.to, checkpoint.threadId);
            } else {
              to = id;
              if (input.options.from !== undefined) {
                from = checkpointFor(input.options.from, checkpoint.threadId);
              } else {
                const earlier = store
                  .listCheckpoints(checkpoint.threadId)
                  .filter((row) => row.seq < checkpoint.seq && row.status === "ok" && row.workspace === checkpoint.workspace);
                from = earlier.at(-1)?.id ?? "empty";
              }
            }
            const paths = input.options.path;
            if (paths.length > 50) throw new PluginCliError("At most 50 --path values.", { code: "invalid_value" });
            const result = await service.diff({
              threadId: threadHint ?? checkpoint.threadId,
              from,
              to,
              ...(paths.length > 0 ? { paths } : {}),
              patch: !input.options.stat,
            });
            if (input.options.json) return json({ from, to, ...result });
            const header = `Diff ${from} -> ${to}\n`;
            return text(header + (input.options.stat ? formatDiffStat(result.files, result.totalFiles, result.stats) : formatDiffPatch(result.files, result.totalFiles)));
          }),
      }),

      restore: cliCommand({
        summary: "Restore the thread's files to a checkpoint (preview with --dry-run, apply with --yes)",
        description:
          "Takes a pre-restore checkpoint first, so `bb rewind undo` can put the files back. Never touches ignored files, files over the size cap, nested repositories, or .git, and refuses while a thread in the workspace is running.",
        positionals: [{ name: "checkpoint", description: "Checkpoint id (ck_…) or a unique prefix", required: true }],
        options: {
          "dry-run": { type: "boolean", description: "Show what would change; write nothing", aliases: ["dryrun", "preview"] },
          yes: { type: "boolean", description: "Apply the restore", short: "y", aliases: ["confirm", "force"] },
          "stop-running": { type: "boolean", description: "Stop threads running in this workspace first" },
          "edit-message": {
            type: "string",
            description: "Then replace the message this checkpoint preceded with this text; bb discards it and every later turn",
            stdin: true,
          },
          "edit-message-file": { type: "string", description: "Like --edit-message, reading the new text from a file on this machine (max 100 KB)", placeholder: "path" },
          thread: threadOption,
          json: jsonOption,
        },
        constraints: [
          { kind: "at-most-one", options: ["dry-run", "yes"] },
          { kind: "at-most-one", options: ["edit-message", "edit-message-file"] },
        ],
        run: (input, ctx) =>
          guard(async () => {
            const threadId = threadFor(input.options.thread, ctx, "restore");
            const id = checkpointFor(input.positionals.checkpoint, threadId);
            let newText = input.options["edit-message"];
            if (input.options["edit-message-file"] !== undefined) newText = await readPromptFile(input.options["edit-message-file"], threadId, ctx);
            const message = newText === undefined ? null : await service.messageAfter(threadId, id);
            if (input.options["dry-run"]) {
              const preview = await service.preview(threadId, id);
              if (input.options.json) return json(message === null ? preview : { ...preview, editMessage: message });
              const lines = [formatPreview(preview)];
              if (message !== null) {
                lines.push(
                  "",
                  `With --yes this then replaces message ${message.number ?? ""} (“${message.text.replace(/\s+/gu, " ").slice(0, 80)}”): bb discards it and every later turn. The files can be undone; the conversation edit follows bb's rules.`,
                );
              }
              return text(lines.join("\n"));
            }
            if (!input.options.yes) {
              throw new PluginCliError("Restoring overwrites files in the workspace; nothing was changed.", {
                code: "confirmation_required",
                hint: `Preview with \`bb rewind restore ${id} --dry-run\`, then apply with \`bb rewind restore ${id} --yes\`. Every restore can be undone with \`bb rewind undo --yes\`.`,
              });
            }
            await refuseSelfRestore(service, threadId, ctx, `restore ${id} --yes`);
            if (input.options["stop-running"]) await service.stopRunning(threadId);
            if (message !== null && newText !== undefined) {
              const result = await service.editMessage({ threadId, sourceSeqEnd: message.sourceSeqEnd, text: newText, checkpointId: id });
              if (input.options.json) return json(result);
              return text([formatRestoreOutcome(result.outcome, "Restored"), "", ...formatEditResult(result.edit)].join("\n"));
            }
            const outcome = await service.restore(threadId, id);
            return input.options.json ? json(outcome) : text(formatRestoreOutcome(outcome, "Restored"));
          }),
      }),

      undo: cliCommand({
        summary: "Undo the latest restore in the thread's workspace (apply with --yes)",
        positionals: [{ name: "restore", description: "Restore id (rs_…); defaults to the latest restore", required: false }],
        options: {
          "dry-run": { type: "boolean", description: "Show what undoing would change; write nothing", aliases: ["dryrun", "preview"] },
          yes: { type: "boolean", description: "Apply the undo", short: "y", aliases: ["confirm", "force"] },
          "stop-running": { type: "boolean", description: "Stop threads running in this workspace first" },
          thread: threadOption,
          json: jsonOption,
        },
        constraints: [{ kind: "at-most-one", options: ["dry-run", "yes"] }],
        run: (input, ctx) =>
          guard(async () => {
            const threadId = threadFor(input.options.thread, ctx, "undo");
            const restoreId = input.positionals.restore;
            if (restoreId !== undefined && !RESTORE_ID_PATTERN.test(restoreId)) {
              throw new PluginCliError(`"${restoreId}" is not a restore id.`, { code: "invalid_value", hint: "Restore ids look like rs_…; `bb rewind list` shows them." });
            }
            if (input.options["dry-run"]) {
              const { workspace } = await service.resolveWorkspace(threadId);
              const target = restoreId !== undefined ? store.getRestore(restoreId) : store.latestRestoreInWorkspace(workspace.hostId, workspace.path);
              if (target === null || target.preRestoreCheckpointId === null) throw new RewindError("nothing_to_undo", "There is no restore to undo in this workspace.");
              const preview = await service.preview(threadId, target.preRestoreCheckpointId);
              return input.options.json ? json(preview) : text(formatPreview(preview).replace(/^Dry run: restore/u, "Dry run: undo by restoring"));
            }
            if (!input.options.yes) {
              throw new PluginCliError("Undoing a restore overwrites files in the workspace; nothing was changed.", {
                code: "confirmation_required",
                hint: "Preview with `bb rewind undo --dry-run`, then apply with `bb rewind undo --yes`.",
              });
            }
            await refuseSelfRestore(service, threadId, ctx, "undo --yes");
            if (input.options["stop-running"]) await service.stopRunning(threadId);
            const outcome = await service.undo(threadId, restoreId);
            return input.options.json ? json(outcome) : text(formatRestoreOutcome(outcome, "Undid"));
          }),
      }),

      checkpoint: cliCommand({
        summary: "Take a checkpoint of the thread's workspace now",
        options: {
          label: { type: "string", description: "A short note shown with the checkpoint (max 200 characters)", aliases: ["message", "m"] },
          thread: threadOption,
          json: jsonOption,
        },
        run: (input, ctx) =>
          guard(async () => {
            const threadId = threadFor(input.options.thread, ctx, "checkpoint");
            const row = await service.checkpointNow(threadId, input.options.label ?? null);
            const dto = toCheckpointDto(row);
            if (input.options.json) return json(dto);
            return text(`Checkpoint ${dto.id} taken (${statsLabel(dto) || "no changes"}${dto.skippedCount > 0 ? `, ${dto.skippedCount} skipped` : ""}).`);
          }),
      }),

      fork: cliCommand({
        summary: "Fork the conversation at a checkpoint into a new worktree with that checkpoint's files",
        description:
          "A checkpoint taken before a message forks the conversation just before that message; any other checkpoint forks after the last reply it includes. The new worktree's files are restored to the checkpoint before the optional prompt is sent.",
        positionals: [{ name: "checkpoint", description: "Checkpoint id (ck_…) or a unique prefix", required: true }],
        options: {
          prompt: { type: "string", description: "First message for the fork", stdin: true },
          "prompt-file": { type: "string", description: "Read the first message from a file on this machine (max 100 KB)", placeholder: "path" },
          title: { type: "string", description: "Title of the new thread (max 200 characters)" },
          "no-wait": { type: "boolean", description: "Return as soon as the fork starts instead of waiting for its files" },
          thread: threadOption,
          json: jsonOption,
        },
        constraints: [{ kind: "at-most-one", options: ["prompt", "prompt-file"] }],
        run: (input, ctx) =>
          guard(async () => {
            const threadId = threadFor(input.options.thread, ctx, "fork");
            const id = checkpointFor(input.positionals.checkpoint, threadId);
            let prompt = input.options.prompt;
            if (input.options["prompt-file"] !== undefined) prompt = await readPromptFile(input.options["prompt-file"], threadId, ctx);
            let job = await service.fork({
              threadId,
              checkpointId: id,
              ...(prompt === undefined ? {} : { prompt }),
              ...(input.options.title === undefined ? {} : { title: input.options.title }),
            });
            if (!input.options["no-wait"]) job = await service.waitForFork(job.id, 10 * 60_000);
            if (input.options.json) return json(job);
            if (job.status === "failed") throw new RewindError("fork_failed", formatForkJob(job));
            return text(formatForkJob(job));
          }),
      }),

      status: cliCommand({
        summary: "Show Rewind's settings, gate latency, and the thread's checkpoint state",
        options: { thread: threadOption, json: jsonOption },
        run: (input, ctx) =>
          guard(async () => {
            const status = service.status();
            const threadId = optionalThread(input.options.thread, ctx);
            const thread = threadId === null ? null : { threadId, ...service.summary(threadId) };
            let workspace: unknown = null;
            if (threadId !== null) {
              try {
                const listed = await service.list(threadId, 1);
                workspace = listed.workspace ?? { error: listed.workspaceError };
              } catch (error) {
                workspace = { error: error instanceof Error ? error.message : String(error) };
              }
            }
            if (input.options.json) return json({ ...status, thread, workspace });
            const gate = status.gate;
            const lines = [
              `Automatic checkpoints: ${status.settings.enabled ? "on" : "off"}`,
              `Message hold: ${status.settings.gateHoldMs} ms, then queued; size cap ${status.settings.maxFileSizeMB} MB; keep ${status.settings.maxCheckpointsPerThread} per thread; archived threads ${status.settings.retentionDays} days`,
              "",
              `Message gate (last ${plural(gate.samples, "dispatch", "dispatches")}, ${gate.snapshots} with a checkpoint): ${gate.waits} queued, ${gate.released} sent before their checkpoint finished, ${gate.failed} failed`,
            ];
            const line = (label: string, value: { p50: number; p95: number; max: number } | null) => {
              if (value !== null) lines.push(`  ${label.padEnd(9)} p50 ${value.p50} ms, p95 ${value.p95} ms, max ${value.max} ms`);
            };
            line("held:", gate.heldMs);
            line("snapshot:", gate.snapshotMs);
            line("queued:", gate.queuedMs);
            line("recheck:", gate.recheckMs);
            if (thread !== null) {
              lines.push("", `Thread ${thread.threadId}: ${plural(thread.count, "checkpoint")}${thread.pending > 0 ? ` (${thread.pending} capturing)` : ""}${thread.lastCheckpointAt === null ? "" : `, last at ${formatTime(thread.lastCheckpointAt)}`}`);
              const info = workspace as { path?: string; unsupported?: string | null; running?: unknown[]; error?: string } | null;
              if (info?.path !== undefined) lines.push(`Workspace: ${info.path}${info.unsupported ? ` (unsupported: ${info.unsupported})` : ""}`);
              if (info?.error !== undefined) lines.push(`Workspace: ${info.error}`);
            }
            return text(lines.join("\n"));
          }),
      }),

      prune: cliCommand({
        summary: "Apply retention now, or delete one thread's checkpoints with --thread",
        description:
          "Without --thread, runs the daily cleanup now: keeps each thread's newest checkpoints, drops archived threads' checkpoints after the retention period, removes stores of vanished workspaces, and compacts them. With --thread, deletes every checkpoint of that thread (needs --yes).",
        options: {
          "dry-run": { type: "boolean", description: "Report what would be deleted; delete nothing", aliases: ["dryrun"] },
          thread: { ...threadOption, description: "Delete every checkpoint of this thread (needs --yes)" },
          yes: { type: "boolean", description: "Confirm deleting a thread's checkpoints", short: "y" },
          json: jsonOption,
        },
        run: (input) =>
          guard(async () => {
            if (input.options.thread !== undefined) {
              const threadId = threadFor(input.options.thread, {}, "prune");
              if (!input.options["dry-run"] && !input.options.yes) {
                throw new PluginCliError(`Deleting every checkpoint of ${threadId} cannot be undone.`, {
                  code: "confirmation_required",
                  hint: `Check with \`bb rewind prune --thread ${threadId} --dry-run\`, then run it with --yes.`,
                });
              }
              const count = await service.pruneThread(threadId, { dryRun: input.options["dry-run"] });
              if (input.options.json) return json({ threadId, deleted: input.options["dry-run"] ? 0 : count, wouldDelete: count });
              return text(`${input.options["dry-run"] ? "Would delete" : "Deleted"} ${plural(count, "checkpoint")} of ${threadId}.`);
            }
            const result = await service.retention({ dryRun: input.options["dry-run"] });
            if (input.options.json) return json(result);
            const reasons = Object.entries(result.byReason)
              .map(([reason, count]) => `${count} ${reason}`)
              .join(", ");
            const stores = plural(result.shadowsRemoved, "unused workspace store");
            const lines = input.options["dry-run"]
              ? [`Would delete ${plural(result.deleted, "checkpoint")}${reasons.length > 0 ? ` (${reasons})` : ""} and remove ${stores}.`]
              : [
                  `Deleted ${plural(result.deleted, "checkpoint")}${reasons.length > 0 ? ` (${reasons})` : ""}.`,
                  `Removed ${plural(result.refsDeleted, "stale ref")} and ${stores}.`,
                ];
            if (result.hostsSkipped.length > 0) lines.push(`Skipped offline machines: ${result.hostsSkipped.join(", ")}`);
            return text(lines.join("\n"));
          }),
      }),
    },
  });
}

