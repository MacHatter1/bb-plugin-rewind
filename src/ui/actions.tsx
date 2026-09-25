// Restore preview + confirm, fork, and copy-id actions shared by the focus
// card, the turn list, and the restore history.
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { undoneEffectsSentence } from "../effect-text";
import type { CheckpointDto } from "../rpc-contract";
import { type ForkJobResult, type PreviewResult, type RestoreOutcomeResult, type Rpc, useLoadable, useRewindRpc } from "./data";
import { FileDiffs } from "./FileDiffs";
import { clockTime, errorMessage, kindLabel, lateNote, plural, PROTECT_REASON_LABELS } from "./labels";
import { CodeText, Notice, Spinner } from "./parts";

export async function copyCheckpointId(id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(id);
    toast.success(`Copied ${id}`);
  } catch {
    toast.error(`Could not copy. The id is ${id}`);
  }
}

function outcomeSummary(outcome: RestoreOutcomeResult): string {
  const plan = outcome.plan;
  const parts = [`${plan.writes} written`, `${plan.creates} created`, `${plan.deletes} deleted`];
  if (plan.protectedCount > 0) parts.push(`${plan.protectedCount} left alone`);
  const verified = outcome.verification?.ok === false ? " Verification found differences; see the Checkpoints panel." : "";
  const warnings = outcome.warnings.length > 0 ? ` ${outcome.warnings.join(" ")}` : "";
  const outside = undoneEffectsSentence(outcome.effects);
  return `${parts.join(", ")}.${verified}${warnings}${outside === null ? "" : ` ${outside.replaceAll("`", "")}`}`;
}

/**
 * Toast a failed restore. One that stopped part way changed some files, so it
 * gets an Undo action like a finished one.
 */
export function announceRestoreFailure(rpc: Rpc, threadId: string, cause: unknown): void {
  const message = errorMessage(cause);
  if (message.startsWith("The restore did not finish")) {
    const undo = () => {
      toast.promise(rpc.call("undo", { threadId }), {
        loading: "Undoing the restore…",
        success: (result) => `Restore undone. ${outcomeSummary(result)}`,
        error: (error: unknown) => `Undo failed: ${errorMessage(error)}`,
      });
    };
    toast.error("The restore did not finish", { description: message, action: { label: "Undo", onClick: undo }, duration: 30_000 });
    return;
  }
  toast.error(message.startsWith("Nothing was restored") ? message : `Nothing was restored: ${message}`);
}

/** Toast a finished restore with an Undo action. */
export function announceRestore(rpc: Rpc, threadId: string, outcome: RestoreOutcomeResult, verb: string): void {
  const undo = () => {
    const pending = rpc.call("undo", { threadId, restoreId: outcome.restore.id });
    toast.promise(pending, {
      loading: "Undoing the restore…",
      success: (result) => `Restore undone. ${outcomeSummary(result)}`,
      error: (cause: unknown) => `Undo failed: ${errorMessage(cause)}`,
    });
  };
  const show = outcome.verification?.ok === false || outcome.warnings.length > 0 ? toast.warning : toast.success;
  const note = outcome.note !== null ? " A note for your next message is ready above the message box." : "";
  show(verb, { description: `${outcomeSummary(outcome)}${note}`, action: { label: "Undo", onClick: undo }, duration: 10_000 });
}

/** The user message "Restore files and edit this message" replaces. */
export interface EditableMessage {
  sourceSeqEnd: number;
  number: number | null;
  text: string;
}

function PlanBody({ threadId, preview }: { threadId: string; preview: PreviewResult }) {
  const plan = preview.plan;
  const total = plan.writes + plan.creates + plan.deletes;
  return (
    <div className="space-y-2">
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">The files already match this checkpoint.</p>
      ) : (
        <p className="text-sm">
          Restoring changes {plural(total, "file")}: {plan.writes} written, {plan.creates} created, {plan.deletes} deleted.
        </p>
      )}
      {total > 0 ? (
        <details className="rounded-md border border-border px-2 py-1">
          <summary className="cursor-pointer select-none py-1 text-xs text-muted-foreground">Show the changes (current files → checkpoint)</summary>
          <div className="pt-1">
            <FileDiffs threadId={threadId} from="current" to={preview.checkpoint.id} />
          </div>
        </details>
      ) : null}
      {plan.protectedCount > 0 ? (
        <Notice tone="info" icon="Lock">
          <p>
            {plural(plan.protectedCount, "path")} will be left alone because a restore never touches files it did not capture:
          </p>
          <ul className="mt-1 space-y-0.5">
            {plan.protected.slice(0, 20).map((entry) => (
              <li key={entry.path} className="truncate">
                <span className="font-mono">{entry.path}</span> — {PROTECT_REASON_LABELS[entry.reason] ?? entry.reason}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {preview.skippedCount > 0 ? (
        <Notice tone="info">
          {plural(preview.skippedCount, "file")} in the workspace {preview.skippedCount === 1 ? "is" : "are"} not captured (over the size cap or nested repositories) and stay as they are.
        </Notice>
      ) : null}
    </div>
  );
}

/** Preview of restoring `checkpoint`, with the actions. */
export function RestorePreview({
  threadId,
  checkpoint,
  anchorSeq,
  message,
  children,
}: {
  threadId: string;
  checkpoint: CheckpointDto;
  anchorSeq?: number;
  /** Offer "Restore files and edit this message" for this user message. */
  message?: EditableMessage;
  children?: ReactNode;
}) {
  const rpc = useRewindRpc();
  const preview = useLoadable(threadId, () => rpc.call("preview", { threadId, checkpointId: checkpoint.id }), checkpoint.id);
  const [busy, setBusy] = useState<"stopping" | "restoring" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [forking, setForking] = useState(false);
  const [editing, setEditing] = useState(false);

  const restore = async (stopFirst: boolean) => {
    setBusy(stopFirst ? "stopping" : "restoring");
    try {
      if (stopFirst) {
        const { stopped } = await rpc.call("stopRunning", { threadId });
        if (stopped.length > 0) toast.info(`Stopped ${plural(stopped.length, "thread")}`);
        setBusy("restoring");
      }
      const outcome = await rpc.call("restore", { threadId, checkpointId: checkpoint.id });
      announceRestore(rpc, threadId, outcome, "Files restored");
      setConfirming(false);
    } catch (cause) {
      announceRestoreFailure(rpc, threadId, cause);
    } finally {
      setBusy(null);
    }
  };

  const data = preview.data;
  const running = data?.workspace.running ?? [];
  const total = data === null ? 0 : data.plan.writes + data.plan.creates + data.plan.deletes;
  return (
    <div className="space-y-3">
      {checkpoint.status === "pending" ? <Spinner label="This checkpoint is still being captured…" /> : null}
      {preview.error !== null ? <Notice tone="danger">{preview.error}</Notice> : null}
      {data === null && preview.error === null ? <Spinner label="Working out what a restore would change…" /> : null}
      {data !== null ? (
        <>
          {data.headMoved ? (
            <Notice tone="warning" icon="GitBranch">
              Git HEAD moved since this checkpoint ({checkpoint.head?.sha?.slice(0, 8) ?? "?"} → {data.currentHead?.sha?.slice(0, 8) ?? "?"}), for example the
              agent committed. Rewind restores files only: commits and branches stay as they are.
            </Notice>
          ) : null}
          {checkpoint.late ? (
            <Notice tone="warning" icon="Clock">
              {lateNote(checkpoint.kind)}
            </Notice>
          ) : null}
          {undoneEffectsSentence(data.effects) !== null ? (
            <Notice tone="warning">
              <CodeText text={`${undoneEffectsSentence(data.effects)!} Restoring puts back the files only.`} />
            </Notice>
          ) : null}
          {running.length > 0 ? (
            <Notice tone="warning" icon="Pause">
              <p>
                Not restoring while {running.map((thread) => (thread.isSelf ? "this thread" : (thread.title ?? thread.id))).join(", ")}{" "}
                {running.length === 1 ? "is" : "are"} running in this workspace: the agent could overwrite the restored files.
              </p>
              <Button size="sm" variant="outline" className="mt-2" disabled={busy !== null} onClick={() => void restore(true)}>
                {busy === "stopping" ? "Stopping…" : `Stop ${running.length === 1 ? "it" : "them"} and restore`}
              </Button>
            </Notice>
          ) : null}
          <PlanBody threadId={threadId} preview={data} />
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={data === null || total === 0 || running.length > 0 || busy !== null} onClick={() => setConfirming(true)}>
          <Icon name="RotateCcw" aria-hidden />
          Restore files
        </Button>
        {message !== undefined ? (
          <Button size="sm" variant="outline" disabled={data === null || running.length > 0 || busy !== null} onClick={() => setEditing(true)}>
            <Icon name="Edit" aria-hidden />
            Restore files and edit this message
          </Button>
        ) : null}
        <span title={checkpoint.head === null ? "Forking with files needs a git repository" : undefined} className="inline-flex">
          <Button size="sm" variant="outline" disabled={checkpoint.status !== "ok" || checkpoint.head === null} onClick={() => setForking(true)}>
            <Icon name="Fork" aria-hidden />
            Fork from here with files
          </Button>
        </span>
        <Button size="sm" variant="ghost" onClick={() => void copyCheckpointId(checkpoint.id)}>
          <Icon name="Copy" aria-hidden />
          Copy id
        </Button>
        {children}
      </div>
      <Dialog open={confirming} onOpenChange={(open) => busy === null && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore files?</DialogTitle>
            <DialogDescription>
              The workspace goes back to the {kindLabel(checkpoint).toLowerCase()} checkpoint from {clockTime(checkpoint.createdAt)}. A checkpoint of the current files is
              taken first, so you can undo this.
            </DialogDescription>
          </DialogHeader>
          {data !== null ? <p className="text-sm">{data.plan.writes} written, {data.plan.creates} created, {data.plan.deletes} deleted.</p> : null}
          <DialogFooter>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button disabled={busy !== null} onClick={() => void restore(false)}>
              {busy === "restoring" ? "Restoring…" : "Restore files"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ForkDialog threadId={threadId} checkpoint={checkpoint} {...(anchorSeq === undefined ? {} : { anchorSeq })} open={forking} onOpenChange={setForking} />
      {message !== undefined ? <EditMessageDialog threadId={threadId} message={message} open={editing} onOpenChange={setEditing} /> : null}
    </div>
  );
}

/**
 * Restore the files to before a message, then have bb replace the message:
 * files and conversation go back together, in this thread.
 */
export function EditMessageDialog({
  threadId,
  message,
  open,
  onOpenChange,
}: {
  threadId: string;
  message: EditableMessage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRewindRpc();
  const [text, setText] = useState(message.text);
  const [busy, setBusy] = useState(false);
  const which = message.number === null ? "this message" : `message ${message.number}`;
  const submit = async () => {
    setBusy(true);
    try {
      const { outcome, edit } = await rpc.call("editMessage", { threadId, sourceSeqEnd: message.sourceSeqEnd, text });
      onOpenChange(false);
      if (edit.ok) {
        announceRestore(rpc, threadId, outcome, `Files restored and ${which} replaced`);
      } else {
        toast.warning(`Files restored, but bb did not edit ${which}`, {
          description: `${edit.error} The restore stays; a note for your next message is ready above the message box.`,
          duration: 15_000,
        });
      }
    } catch (cause) {
      announceRestoreFailure(rpc, threadId, cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore files and edit {which}</DialogTitle>
          <DialogDescription>
            First the files go back to how they were before {which}. That part can be undone, like any restore. Then bb replaces {which} with your new text and
            discards every turn after it; the conversation edit follows bb&apos;s rules, and Rewind cannot undo it.
          </DialogDescription>
        </DialogHeader>
        <label className="space-y-1 text-sm">
          <span className="text-xs text-muted-foreground">New message</span>
          <textarea
            aria-label="New message"
            className="min-h-32 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || text.trim().length === 0} onClick={() => void submit()}>
            {busy ? "Restoring…" : "Restore and edit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function followFork(rpc: Rpc, jobId: string, open: (threadId: string) => void): Promise<void> {
  const toastId = `rewind-fork-${jobId}`;
  toast.loading("Forking with files…", { id: toastId });
  const deadline = Date.now() + 10 * 60_000;
  let job: ForkJobResult | null = null;
  while (Date.now() < deadline) {
    try {
      job = (await rpc.call("forkStatus", { jobId })).job;
    } catch (cause) {
      toast.error(`Lost track of the fork: ${errorMessage(cause)}`, { id: toastId });
      return;
    }
    if (job.status !== "running") break;
    toast.loading(`Forking with files: ${job.step ?? "working"}…`, { id: toastId });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (job?.status === "done" && job.forkThreadId !== null) {
    const forkThreadId = job.forkThreadId;
    toast.success("Forked with files", { id: toastId, action: { label: "Open", onClick: () => open(forkThreadId) }, duration: 15_000 });
  } else {
    toast.error(`Fork failed: ${job?.error ?? "timed out"}`, { id: toastId });
  }
}

export function ForkDialog({ threadId, checkpoint, anchorSeq, open, onOpenChange }: { threadId: string; checkpoint: CheckpointDto; anchorSeq?: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const rpc = useRewindRpc();
  const navigate = useBbNavigate();
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const { job } = await rpc.call("fork", {
        threadId,
        checkpointId: checkpoint.id,
        ...(anchorSeq === undefined ? {} : { anchorSeq }),
        ...(prompt.trim().length > 0 ? { prompt } : {}),
        ...(title.trim().length > 0 ? { title: title.trim() } : {}),
      });
      onOpenChange(false);
      setPrompt("");
      setTitle("");
      void followFork(rpc, job.id, (forkThreadId) => navigate.toThread(forkThreadId));
    } catch (cause) {
      toast.error(`Could not fork: ${errorMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fork from here with files</DialogTitle>
          <DialogDescription>
            A new thread continues this conversation from {checkpoint.kind === "before-turn" ? "just before this message" : "this point"}, in a new worktree whose files match the
            checkpoint from {clockTime(checkpoint.createdAt)}. This thread and its files are not changed.
          </DialogDescription>
        </DialogHeader>
        <label className="space-y-1 text-sm">
          <span className="text-xs text-muted-foreground">First message (optional)</span>
          <textarea
            className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={prompt}
            placeholder="Try a different approach: …"
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs text-muted-foreground">Title (optional)</span>
          <Input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "Starting…" : "Fork"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
