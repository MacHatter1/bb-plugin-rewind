// Agent tools: checkpoint before something risky, and see recent checkpoints.
// There is deliberately no restore tool: restoring is the user's call.
import type { PluginAgents } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { capOutput, checkpointLine, statsLabel } from "./format";
import { RewindError, type RewindService, toCheckpointDto } from "./service";

const TOOL_OUTPUT_BYTES = 16 * 1024;

export function registerTools(agents: PluginAgents, service: RewindService): void {
  agents.registerTool({
    name: "rewind_checkpoint",
    description:
      "Save a checkpoint of this thread's workspace files right now, before a risky operation (a large refactor, a codemod, deleting files, running a script that rewrites files). The user can later restore the files to this point. Returns the checkpoint id.",
    instructions:
      "Rewind already checkpoints the workspace before and after every turn. Call rewind_checkpoint mid-turn before an operation that rewrites many files or is hard to reverse, with a short label saying what comes next. Never restore files yourself; tell the user the checkpoint id instead.",
    presentation: {
      label: { pending: "Saving a Rewind checkpoint", completed: "Saved a Rewind checkpoint" },
    },
    parameters: z
      .object({
        label: z.string().trim().max(200).optional().describe("What you are about to do, e.g. 'before renaming the api module'"),
      })
      .strict(),
    async execute({ label }, ctx) {
      try {
        const row = await service.checkpointNow(ctx.threadId, label ?? null);
        const dto = toCheckpointDto(row);
        const skipped = dto.skippedCount > 0 ? ` ${dto.skippedCount} file(s) were skipped (over the size cap or nested repositories).` : "";
        return `Checkpoint ${dto.id} saved (${statsLabel(dto) || "no changes since the last checkpoint"}).${skipped} The user can restore it from the Checkpoints panel or with \`bb rewind restore ${dto.id} --dry-run\`.`;
      } catch (error) {
        const message = error instanceof RewindError || error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `No checkpoint was saved: ${message}` }], isError: true };
      }
    },
  });

  agents.registerTool({
    name: "rewind_list",
    description: "List this thread's most recent Rewind checkpoints (id, time, kind, files changed), newest first.",
    presentation: {
      label: { pending: "Listing Rewind checkpoints", completed: "Listed Rewind checkpoints" },
      suppress: true,
    },
    parameters: z
      .object({
        limit: z.number().int().min(1).max(50).optional().describe("How many checkpoints to list (default 10, max 50)"),
      })
      .strict(),
    async execute({ limit }, ctx) {
      const listed = await service.list(ctx.threadId, limit ?? 10);
      if (listed.checkpoints.length === 0) return "This thread has no checkpoints yet.";
      const lines = [...listed.checkpoints].reverse().map((checkpoint) => checkpointLine(checkpoint));
      return capOutput(lines.join("\n"), TOOL_OUTPUT_BYTES);
    },
  });
}
