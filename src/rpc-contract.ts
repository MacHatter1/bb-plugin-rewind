// The RPC surface the app uses (and `bb plugin rpc call rewind <method>`).
// app.tsx imports only the type of this contract.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  checkpointIdSchema,
  checkpointKindSchema,
  diffFileSchema,
  fileChangeSchema,
  headSchema,
  planSchema,
  relativePathSchema,
  skippedFileSchema,
  statsSchema,
  verificationSchema,
} from "./host-contract";
import { FORK_ID_PATTERN, RESTORE_ID_PATTERN, THREAD_ID_PATTERN } from "./ids";

export const threadIdSchema = z.string().regex(THREAD_ID_PATTERN);
export const restoreIdSchema = z.string().regex(RESTORE_ID_PATTERN);
export const forkIdSchema = z.string().regex(FORK_ID_PATTERN);

/** A command with an effect outside the workspace (see src/effects.ts). */
export const effectSchema = z.object({ kind: z.string(), label: z.string(), command: z.string() }).strict();
/** One that ran in a turn a restore undoes: Rewind cannot undo it. */
export const undoneEffectSchema = z
  .object({ kind: z.string(), label: z.string(), command: z.string(), turn: z.number().int().nullable() })
  .strict();
export type UndoneEffect = z.infer<typeof undoneEffectSchema>;

export const checkpointDtoSchema = z
  .object({
    id: checkpointIdSchema,
    threadId: z.string(),
    environmentId: z.string(),
    hostId: z.string(),
    workspace: z.string(),
    kind: checkpointKindSchema,
    label: z.string().nullable(),
    attempt: z.enum(["start-turn", "join-turn"]).nullable(),
    status: z.enum(["pending", "ok", "failed", "unsupported"]),
    late: z.boolean(),
    deduped: z.boolean(),
    eventMark: z.number().int().nullable(),
    messageExcerpt: z.string().nullable(),
    commit: z.string().nullable(),
    head: headSchema.nullable(),
    baseline: z.boolean(),
    stats: statsSchema.nullable(),
    changes: z.array(fileChangeSchema),
    changesTruncated: z.boolean(),
    skipped: z.array(skippedFileSchema),
    skippedCount: z.number().int().min(0),
    durationMs: z.number().nullable(),
    error: z.string().nullable(),
    createdAt: z.number(),
    completedAt: z.number().nullable(),
    /** Commands since the previous checkpoint with effects outside the workspace; null until scanned. */
    effects: z.array(effectSchema).nullable(),
  })
  .strict();
export type CheckpointDto = z.infer<typeof checkpointDtoSchema>;

export const restoreSummarySchema = z
  .object({
    creates: z.number().int().min(0),
    writes: z.number().int().min(0),
    deletes: z.number().int().min(0),
    protectedCount: z.number().int().min(0),
    verified: z.boolean(),
    mismatchCount: z.number().int().min(0),
    untouchedCount: z.number().int().min(0),
  })
  .strict();

export const restoreDtoSchema = z
  .object({
    id: restoreIdSchema,
    threadId: z.string(),
    kind: z.enum(["restore", "undo", "fork"]),
    targetCheckpointId: checkpointIdSchema,
    preRestoreCheckpointId: checkpointIdSchema.nullable(),
    status: z.enum(["ok", "unverified", "failed"]),
    summary: restoreSummarySchema.nullable(),
    error: z.string().nullable(),
    undoneBy: z.string().nullable(),
    createdAt: z.number(),
  })
  .strict();
export type RestoreDto = z.infer<typeof restoreDtoSchema>;

export const runningThreadSchema = z
  .object({ id: z.string(), title: z.string().nullable(), status: z.string(), isSelf: z.boolean() })
  .strict();
export type RunningThread = z.infer<typeof runningThreadSchema>;

export const workspaceInfoSchema = z
  .object({
    environmentId: z.string(),
    hostId: z.string(),
    path: z.string(),
    isGit: z.boolean().nullable(),
    /** Other threads sharing the environment. */
    sharedWith: z.number().int().min(0),
    running: z.array(runningThreadSchema),
    unsupported: z.string().nullable(),
  })
  .strict();
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

export const forkJobSchema = z
  .object({
    id: forkIdSchema,
    sourceThreadId: z.string(),
    checkpointId: checkpointIdSchema,
    forkThreadId: z.string().nullable(),
    status: z.enum(["running", "done", "failed"]),
    step: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type ForkJob = z.infer<typeof forkJobSchema>;

const percentilesSchema = z.object({ p50: z.number(), p95: z.number(), max: z.number() }).strict();

export const settingsDtoSchema = z
  .object({
    enabled: z.boolean(),
    gateHoldMs: z.number(),
    maxFileSizeMB: z.number(),
    maxCheckpointsPerThread: z.number(),
    retentionDays: z.number(),
    projectExcluded: z.boolean(),
  })
  .strict();

const messageSchema = z
  .object({
    threadId: z.string().max(200).optional(),
    role: z.enum(["user", "assistant"]),
    sourceSeqEnd: z.number().int().min(0),
  })
  .strict();

const restoreOutcomeSchema = z
  .object({
    restore: restoreDtoSchema,
    preRestore: checkpointDtoSchema.nullable(),
    plan: planSchema,
    verification: verificationSchema.nullable(),
    warnings: z.array(z.string()),
    /** Commands in the undone turns with effects outside the workspace. */
    effects: z.array(undoneEffectSchema),
    /**
     * A note suggested for the user's next message when the restore undid
     * turns the conversation still contains. Rewind never sends it.
     */
    note: z.string().nullable(),
  })
  .strict();
export type RestoreOutcome = z.infer<typeof restoreOutcomeSchema>;

const editResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), requestSequence: z.number(), message: z.number().int().nullable() }).strict(),
  z.object({ ok: z.literal(false), error: z.string(), message: z.number().int().nullable() }).strict(),
]);

const messageInfoSchema = z
  .object({
    /** 1-based among the thread's turn-starting messages; null if unknown. */
    number: z.number().int().min(1).nullable(),
    text: z.string(),
    /** "Restore files and edit this message" applies. */
    editable: z.boolean(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  summary: {
    experimental_description: "Checkpoint count and state for a thread (header control).",
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z
      .object({
        enabled: z.boolean(),
        count: z.number().int().min(0),
        pending: z.number().int().min(0),
        lastCheckpointAt: z.number().nullable(),
      })
      .strict(),
  },
  list: {
    experimental_description: "A thread's checkpoints (oldest first), restores, and workspace state.",
    input: z.object({ threadId: threadIdSchema, limit: z.number().int().min(1).max(1_000).optional() }).strict(),
    output: z
      .object({
        threadId: z.string(),
        checkpoints: z.array(checkpointDtoSchema),
        restores: z.array(restoreDtoSchema),
        workspace: workspaceInfoSchema.nullable(),
        workspaceError: z.string().nullable(),
        settings: settingsDtoSchema,
      })
      .strict(),
  },
  resolveMessage: {
    experimental_description:
      "The checkpoint 'Rewind to here' targets for a chat message: before a user message, after an assistant reply.",
    input: z.object({ threadId: threadIdSchema, message: messageSchema }).strict(),
    output: z
      .object({
        match: z.enum(["exact", "fallback", "none"]),
        checkpoint: checkpointDtoSchema.nullable(),
        note: z.string(),
        /** For a user message of this thread: its number and full text. */
        message: messageInfoSchema.nullable(),
      })
      .strict(),
  },
  editMessage: {
    experimental_description:
      "Restore the files to before a user message, then have bb replace that message, discarding it and every later turn.",
    input: z
      .object({
        threadId: threadIdSchema,
        sourceSeqEnd: z.number().int().min(0),
        text: z.string().trim().min(1).max(100_000),
      })
      .strict(),
    output: z.object({ outcome: restoreOutcomeSchema, edit: editResultSchema }).strict(),
  },
  note: {
    experimental_description: "The note suggested for the thread's next message after a restore, if any.",
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ note: z.object({ text: z.string(), createdAt: z.number() }).strict().nullable() }).strict(),
  },
  dismissNote: {
    experimental_description: "Dismiss the suggested note for the thread's next message.",
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ dismissed: z.boolean() }).strict(),
  },
  preview: {
    experimental_description: "What restoring a checkpoint would change (a dry run; nothing is written).",
    input: z.object({ threadId: threadIdSchema, checkpointId: checkpointIdSchema }).strict(),
    output: z
      .object({
        checkpoint: checkpointDtoSchema,
        plan: planSchema,
        skipped: z.array(skippedFileSchema),
        skippedCount: z.number().int().min(0),
        currentHead: headSchema.nullable(),
        headMoved: z.boolean(),
        workspace: workspaceInfoSchema,
        /** Commands in the turns this restore would undo that had effects outside the workspace. */
        effects: z.array(undoneEffectSchema),
      })
      .strict(),
  },
  diff: {
    experimental_description: "File changes between two states of a thread's workspace, with optional per-file patches.",
    input: z
      .object({
        threadId: threadIdSchema,
        from: z.union([checkpointIdSchema, z.literal("empty"), z.literal("current")]),
        to: z.union([checkpointIdSchema, z.literal("current")]),
        paths: z.array(relativePathSchema).max(50).optional(),
        patch: z.boolean().optional(),
      })
      .strict(),
    output: z
      .object({
        files: z.array(diffFileSchema),
        totalFiles: z.number().int().min(0),
        filesTruncated: z.boolean(),
        stats: statsSchema,
      })
      .strict(),
  },
  restore: {
    experimental_description: "Restore the thread's workspace to a checkpoint. Takes a pre-restore checkpoint first.",
    input: z.object({ threadId: threadIdSchema, checkpointId: checkpointIdSchema }).strict(),
    output: restoreOutcomeSchema,
  },
  undo: {
    experimental_description: "Undo the latest restore of the thread's workspace (restores its pre-restore checkpoint).",
    input: z.object({ threadId: threadIdSchema, restoreId: restoreIdSchema.optional() }).strict(),
    output: restoreOutcomeSchema,
  },
  checkpoint: {
    experimental_description: "Take a manual checkpoint of the thread's workspace now.",
    input: z.object({ threadId: threadIdSchema, label: z.string().trim().max(200).optional() }).strict(),
    output: z.object({ checkpoint: checkpointDtoSchema }).strict(),
  },
  fork: {
    experimental_description:
      "Fork the conversation at a checkpoint (or message) into a new worktree whose files match that checkpoint.",
    input: z
      .object({
        threadId: threadIdSchema,
        checkpointId: checkpointIdSchema,
        /** The message's sourceSeqEnd when forking from a chat message. */
        anchorSeq: z.number().int().min(0).optional(),
        prompt: z.string().max(100_000).optional(),
        title: z.string().trim().max(200).optional(),
      })
      .strict(),
    output: z.object({ job: forkJobSchema }).strict(),
  },
  forkStatus: {
    experimental_description: "Progress of a fork started with `fork`.",
    input: z.object({ jobId: forkIdSchema }).strict(),
    output: z.object({ job: forkJobSchema }).strict(),
  },
  stopRunning: {
    experimental_description: "Stop every running thread that shares this thread's workspace, so a restore can proceed.",
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ stopped: z.array(z.string()) }).strict(),
  },
  status: {
    experimental_description: "Plugin status: settings and gate latency statistics.",
    input: z.null(),
    output: z
      .object({
        settings: settingsDtoSchema,
        gate: z
          .object({
            samples: z.number().int().min(0),
            snapshots: z.number().int().min(0),
            /** Messages queued ("wait") until their checkpoint or a restore finished. */
            waits: z.number().int().min(0),
            /** Messages that went out before their checkpoint finished. */
            released: z.number().int().min(0),
            failed: z.number().int().min(0),
            /** How long the hook held each message (bb's dispatch lock). */
            heldMs: percentilesSchema.nullable(),
            snapshotMs: percentilesSchema.nullable(),
            /** How long queued messages waited, until re-attempted or sent. */
            queuedMs: percentilesSchema.nullable(),
            /** From Rewind's recheck to bb's re-attempt of the message. */
            recheckMs: percentilesSchema.nullable(),
          })
          .strict(),
      })
      .strict(),
  },
});
export type RpcContract = typeof rpcContract;
