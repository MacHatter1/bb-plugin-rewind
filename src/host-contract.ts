// RPC between the server and the host entry (host.ts), which runs on the
// machine that holds the thread's workspace. Every method names its workspace
// by absolute path; the host keeps one shadow git repository per workspace.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHECKPOINT_ID_PATTERN } from "./ids";

export const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value), "must be an absolute path")
  .refine((value) => !value.includes("\0"), "must not contain NUL");

/** A workspace-relative path as git prints it: forward slashes, no `..`. */
export const relativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), "must not contain NUL")
  .refine((value) => !value.startsWith("/"), "must be relative")
  .refine((value) => !value.split("/").some((part) => part === ".." || part === ""), "must not contain empty or .. segments");

export const shaSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
export const checkpointIdSchema = z.string().regex(CHECKPOINT_ID_PATTERN);
export const checkpointKindSchema = z.enum(["before-turn", "after-turn", "manual", "pre-restore"]);
export type CheckpointKind = z.infer<typeof checkpointKindSchema>;

export const limitsSchema = z
  .object({
    maxFileBytes: z.number().int().min(1),
    maxFiles: z.number().int().min(1),
    maxTotalBytes: z.number().int().min(1),
  })
  .strict();
export type SnapshotLimits = z.infer<typeof limitsSchema>;

export const skippedFileSchema = z
  .object({
    path: z.string(),
    reason: z.enum(["too-large", "nested-repository", "unreadable"]),
    sizeBytes: z.number().int().min(0).nullable(),
  })
  .strict();
export type SkippedFile = z.infer<typeof skippedFileSchema>;

export const changeStatusSchema = z.enum(["A", "M", "D", "T"]);
export type ChangeStatus = z.infer<typeof changeStatusSchema>;

export const fileChangeSchema = z
  .object({
    path: z.string(),
    status: changeStatusSchema,
    oldMode: z.string().nullable(),
    newMode: z.string().nullable(),
    binary: z.boolean(),
    additions: z.number().int().min(0).nullable(),
    deletions: z.number().int().min(0).nullable(),
  })
  .strict();
export type FileChange = z.infer<typeof fileChangeSchema>;

export const statsSchema = z
  .object({
    files: z.number().int().min(0),
    insertions: z.number().int().min(0),
    deletions: z.number().int().min(0),
  })
  .strict();
export type ChangeStats = z.infer<typeof statsSchema>;

export const headSchema = z
  .object({
    sha: shaSchema.nullable(),
    branch: z.string().max(1024).nullable(),
  })
  .strict();
export type HeadInfo = z.infer<typeof headSchema>;

const missingSchema = z.object({ status: z.literal("missing"), reason: z.string() }).strict();
const unsupportedSchema = z
  .object({
    status: z.literal("unsupported"),
    reason: z.string(),
    fileCount: z.number().int().min(0).nullable(),
    totalBytes: z.number().int().min(0).nullable(),
  })
  .strict();
const unavailableSchema = z.object({ status: z.literal("unavailable"), reason: z.string() }).strict();

export const snapshotOkSchema = z
  .object({
    status: z.literal("ok"),
    commit: shaSchema,
    tree: shaSchema,
    deduped: z.boolean(),
    /** Tree the stats were computed against, or null for a first snapshot. */
    comparedTo: shaSchema.nullable(),
    stats: statsSchema,
    changes: z.array(fileChangeSchema),
    changesTruncated: z.boolean(),
    skipped: z.array(skippedFileSchema),
    skippedCount: z.number().int().min(0),
    /** Null when the workspace is not in a git repository. */
    head: headSchema.nullable(),
    fileCount: z.number().int().min(0),
    durationMs: z.number().min(0),
  })
  .strict();
export type SnapshotOk = z.infer<typeof snapshotOkSchema>;

export const snapshotResultSchema = z.discriminatedUnion("status", [snapshotOkSchema, unsupportedSchema, missingSchema]);
export type SnapshotResult = z.infer<typeof snapshotResultSchema>;

export const revisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checkpoint"), commit: shaSchema, checkpointId: checkpointIdSchema }).strict(),
  z.object({ kind: z.literal("workspace") }).strict(),
  z.object({ kind: z.literal("empty") }).strict(),
]);
export type Revision = z.infer<typeof revisionSchema>;

export const diffFileSchema = fileChangeSchema
  .extend({
    patch: z.string().nullable(),
    patchTruncated: z.boolean(),
  })
  .strict();
export type DiffFile = z.infer<typeof diffFileSchema>;

export const diffResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      fromTree: shaSchema,
      toTree: shaSchema,
      files: z.array(diffFileSchema),
      totalFiles: z.number().int().min(0),
      filesTruncated: z.boolean(),
      stats: statsSchema,
      skipped: z.array(skippedFileSchema),
    })
    .strict(),
  missingSchema,
  unsupportedSchema,
  unavailableSchema,
]);
export type DiffResult = z.infer<typeof diffResultSchema>;

export const planActionSchema = z.enum(["create", "write", "delete"]);
export type PlanAction = z.infer<typeof planActionSchema>;

export const protectReasonSchema = z.enum([
  // The path exists but is outside the checkpoint's scope: ignored, over the
  // size cap, or inside a nested repository.
  "exists-uncaptured",
  // A directory the change would replace still holds uncaptured files.
  "directory-has-uncaptured",
  // A parent of the path is an uncaptured file or symlink.
  "blocked-by-uncaptured",
  // The workspace repository's own ignore rules cover the path.
  "ignored",
  // git could not say whether its rules cover the path; left alone.
  "unverifiable",
]);
export type ProtectReason = z.infer<typeof protectReasonSchema>;

export const planSchema = z
  .object({
    creates: z.number().int().min(0),
    writes: z.number().int().min(0),
    deletes: z.number().int().min(0),
    changes: z.array(
      z
        .object({
          path: z.string(),
          action: planActionSchema,
          binary: z.boolean(),
          additions: z.number().int().min(0).nullable(),
          deletions: z.number().int().min(0).nullable(),
        })
        .strict(),
    ),
    changesTruncated: z.boolean(),
    protected: z.array(z.object({ path: z.string(), reason: protectReasonSchema, action: planActionSchema }).strict()),
    protectedCount: z.number().int().min(0),
  })
  .strict();
export type RestorePlan = z.infer<typeof planSchema>;

export const verificationSchema = z
  .object({
    ok: z.boolean(),
    mismatches: z.array(z.object({ path: z.string(), problem: z.string() }).strict()),
    mismatchCount: z.number().int().min(0),
    /** Files now present that the restore left alone (ignored before it). */
    untouched: z.array(z.string()),
    untouchedCount: z.number().int().min(0),
  })
  .strict();
export type Verification = z.infer<typeof verificationSchema>;

export const restoreResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      applied: z.boolean(),
      currentTree: shaSchema,
      targetTree: shaSchema,
      effectiveTree: shaSchema,
      plan: planSchema,
      head: headSchema.nullable(),
      preRestore: snapshotOkSchema.nullable(),
      verification: verificationSchema.nullable(),
      /**
       * Set when the restore failed after its pre-restore checkpoint was
       * taken. `applied` then says whether files may already have changed;
       * restoring `preRestore` puts them back.
       */
      applyError: z.string().nullable(),
      skipped: z.array(skippedFileSchema),
      skippedCount: z.number().int().min(0),
      durationMs: z.number().min(0),
    })
    .strict(),
  missingSchema,
  unsupportedSchema,
  unavailableSchema,
]);
export type RestoreResult = z.infer<typeof restoreResultSchema>;

export const shadowInfoSchema = z
  .object({
    key: z.string(),
    workspace: z.string(),
    lastUsedAt: z.number().nullable(),
    refCount: z.number().int().min(0).nullable(),
  })
  .strict();

export const hostContract = defineRpcContract({
  snapshot: {
    input: z
      .object({
        workspace: absolutePathSchema,
        checkpointId: checkpointIdSchema,
        kind: checkpointKindSchema,
        subject: z.string().max(500),
        compareTo: shaSchema.nullable(),
        limits: limitsSchema,
        /** More directories to leave alone (bb thread storage inside the workspace). */
        excludePaths: z.array(absolutePathSchema).max(50).optional(),
        /** Re-measure a workspace previously marked unsupported. */
        force: z.boolean(),
      })
      .strict(),
    output: snapshotResultSchema,
  },
  diff: {
    input: z
      .object({
        workspace: absolutePathSchema,
        from: revisionSchema,
        to: revisionSchema,
        paths: z.array(relativePathSchema).max(200).nullable(),
        patch: z.boolean(),
        maxFiles: z.number().int().min(1).max(5_000),
        maxPatchBytesPerFile: z.number().int().min(1),
        maxPatchBytesTotal: z.number().int().min(1),
        limits: limitsSchema,
        /** More directories to leave alone (bb thread storage inside the workspace). */
        excludePaths: z.array(absolutePathSchema).max(50).optional(),
      })
      .strict(),
    output: diffResultSchema,
  },
  restore: {
    input: z
      .object({
        workspace: absolutePathSchema,
        target: z
          .object({
            commit: shaSchema,
            checkpointId: checkpointIdSchema,
            /** Shadow to fetch the commit from when it is not in this one. */
            sourceWorkspace: absolutePathSchema.nullable(),
          })
          .strict(),
        dryRun: z.boolean(),
        preRestore: z.object({ checkpointId: checkpointIdSchema, subject: z.string().max(500) }).strict().nullable(),
        limits: limitsSchema,
        /** More directories to leave alone (bb thread storage inside the workspace). */
        excludePaths: z.array(absolutePathSchema).max(50).optional(),
        maxListed: z.number().int().min(1).max(5_000),
      })
      .strict()
      .refine((input) => input.dryRun || input.preRestore !== null, "an applied restore needs a pre-restore checkpoint"),
    output: restoreResultSchema,
  },
  refCommit: {
    input: z.object({ workspace: absolutePathSchema, checkpointId: checkpointIdSchema }).strict(),
    output: z.object({ commit: shaSchema.nullable(), tree: shaSchema.nullable() }).strict(),
  },
  deleteRefs: {
    input: z.object({ workspace: absolutePathSchema, checkpointIds: z.array(checkpointIdSchema).max(20_000) }).strict(),
    output: z.object({ deleted: z.number().int().min(0) }).strict(),
  },
  reconcile: {
    input: z
      .object({
        workspace: absolutePathSchema,
        /** Every checkpoint the server still knows for this workspace. */
        keepCheckpointIds: z.array(checkpointIdSchema).max(200_000),
        /** Refs newer than this are kept even when unknown (in-flight inserts). */
        minAgeMs: z.number().int().min(0),
        gc: z.boolean(),
      })
      .strict(),
    output: z
      .object({
        deletedRefs: z.number().int().min(0),
        gcRan: z.boolean(),
        sizeBytes: z.number().int().min(0).nullable(),
      })
      .strict(),
  },
  listShadows: {
    input: z.object({}).strict(),
    output: z.object({ shadows: z.array(shadowInfoSchema) }).strict(),
  },
  removeShadow: {
    input: z.object({ key: z.string().regex(/^[0-9a-f]{16,64}$/u) }).strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
  status: {
    input: z.object({ workspace: absolutePathSchema, measureSize: z.boolean() }).strict(),
    output: z
      .object({
        workspaceExists: z.boolean(),
        shadowExists: z.boolean(),
        unsupported: z.object({ reason: z.string(), until: z.number() }).strict().nullable(),
        lastSnapshotAt: z.number().nullable(),
        refCount: z.number().int().min(0).nullable(),
        sizeBytes: z.number().int().min(0).nullable(),
        gitVersion: z.string().nullable(),
      })
      .strict(),
  },
});
export type HostContract = typeof hostContract;
