// The Checkpoints thread panel: a "Rewind to here" focus card when opened
// from a message, the per-turn checkpoint list with file diffs, and the
// restore history with Undo.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { JsonValue, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { turnEffectsSentence } from "../effect-text";
import type { CheckpointDto, RestoreDto } from "../rpc-contract";
import { groupTurns, type TurnGroup } from "../turns";
import { announceRestore, copyCheckpointId, ForkDialog, RestorePreview } from "./actions";
import { type ListResult, useLoadable, useRewindRpc } from "./data";
import { FileDiffs } from "./FileDiffs";
import { clockTime, errorMessage, filesLabel, kindLabel, lateNote, plural, SKIP_REASON_LABELS } from "./labels";
import { Badge, CodeText, Counts, EmptyState, Notice, SectionTitle, Spinner } from "./parts";

export interface FocusParams {
  role: "user" | "assistant";
  sourceSeqEnd: number;
  messageThreadId: string | null;
  excerpt: string | null;
}

/** Panel params round-trip through persistence: validate them. */
export function parseFocus(params: JsonValue | null): FocusParams | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const focus = params.focus;
  if (typeof focus !== "object" || focus === null || Array.isArray(focus)) return null;
  const role = focus.role;
  const sourceSeqEnd = focus.sourceSeqEnd;
  if ((role !== "user" && role !== "assistant") || typeof sourceSeqEnd !== "number" || !Number.isInteger(sourceSeqEnd) || sourceSeqEnd < 0) return null;
  const messageThreadId = typeof focus.messageThreadId === "string" && /^thr_[a-z0-9]{4,64}$/u.test(focus.messageThreadId) ? focus.messageThreadId : null;
  const excerpt = typeof focus.excerpt === "string" ? focus.excerpt.slice(0, 200) : null;
  return { role, sourceSeqEnd, messageThreadId, excerpt };
}

function CheckpointBadges({ checkpoint }: { checkpoint: CheckpointDto }) {
  return (
    <>
      {checkpoint.status === "pending" ? <Badge tone="info">capturing</Badge> : null}
      {checkpoint.status === "failed" ? (
        <Badge tone="danger" title={checkpoint.error ?? undefined}>
          checkpoint failed
        </Badge>
      ) : null}
      {checkpoint.status === "unsupported" ? (
        <Badge tone="warning" title={checkpoint.error ?? undefined}>
          workspace too large
        </Badge>
      ) : null}
      {checkpoint.late ? (
        <Badge tone="warning" title={lateNote(checkpoint.kind)}>
          late
        </Badge>
      ) : null}
      {checkpoint.skippedCount > 0 ? (
        <Badge
          tone="neutral"
          title={checkpoint.skipped.map((entry) => `${entry.path} (${SKIP_REASON_LABELS[entry.reason] ?? entry.reason})`).join("\n")}
        >
          {checkpoint.skippedCount} skipped
        </Badge>
      ) : null}
    </>
  );
}

function FocusCard({ threadId, focus }: { threadId: string; focus: FocusParams }) {
  const rpc = useRewindRpc();
  const resolved = useLoadable(
    threadId,
    () =>
      rpc.call("resolveMessage", {
        threadId,
        message: { role: focus.role, sourceSeqEnd: focus.sourceSeqEnd, ...(focus.messageThreadId === null ? {} : { threadId: focus.messageThreadId }) },
      }),
    `${focus.role}:${focus.sourceSeqEnd}`,
  );
  const title = focus.role === "user" ? "Rewind to before this message" : "Rewind to after this reply";
  const data = resolved.data;
  return (
    <section aria-label={title} className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Icon name="RotateCcw" className="size-4" aria-hidden />
          {title}
        </h2>
        {focus.excerpt !== null ? <p className="line-clamp-2 text-xs text-muted-foreground">“{focus.excerpt}”</p> : null}
      </div>
      {resolved.error !== null ? <Notice tone="danger">{resolved.error}</Notice> : null}
      {data === null && resolved.error === null ? <Spinner label="Finding the checkpoint…" /> : null}
      {data !== null && data.checkpoint === null ? <Notice tone="warning">{data.note}</Notice> : null}
      {data !== null && data.checkpoint !== null ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>
              {kindLabel(data.checkpoint)} · {clockTime(data.checkpoint.createdAt)}
            </span>
            <span className="font-mono">{data.checkpoint.id}</span>
            <CheckpointBadges checkpoint={data.checkpoint} />
          </div>
          {data.match === "fallback" ? <Notice tone="info">{data.note}</Notice> : null}
          {focus.role === "user" && data.message?.editable === false ? (
            <p className="text-xs text-muted-foreground">
              This thread&apos;s agent cannot replace a message, so after a restore Rewind suggests a note for your next message instead.
            </p>
          ) : null}
          <RestorePreview
            threadId={threadId}
            checkpoint={data.checkpoint}
            anchorSeq={focus.sourceSeqEnd}
            {...(focus.role === "user" && data.message?.editable === true
              ? { message: { sourceSeqEnd: focus.sourceSeqEnd, number: data.message.number, text: data.message.text } }
              : {})}
          />
        </>
      ) : null}
    </section>
  );
}

function TurnActions({ threadId, group }: { threadId: string; group: TurnGroup<CheckpointDto> }) {
  const [target, setTarget] = useState<CheckpointDto | null>(null);
  const [forking, setForking] = useState<CheckpointDto | null>(null);
  const usable = (checkpoint: CheckpointDto | null): checkpoint is CheckpointDto => checkpoint !== null && checkpoint.status === "ok";
  const before = usable(group.before) ? group.before : null;
  const after = usable(group.after) ? group.after : null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {before !== null ? (
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setTarget(before)}>
          Restore before
        </Button>
      ) : null}
      {after !== null ? (
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setTarget(after)}>
          {group.kind === "turn" ? "Restore after" : "Restore"}
        </Button>
      ) : null}
      {(before ?? after) !== null && (before ?? after)!.head !== null ? (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setForking(before ?? after)}>
          <Icon name="Fork" aria-hidden />
          Fork
        </Button>
      ) : null}
      {(before ?? after) !== null ? (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-label="Copy checkpoint id" onClick={() => void copyCheckpointId((before ?? after)!.id)}>
          <Icon name="Copy" aria-hidden />
        </Button>
      ) : null}
      {target !== null ? (
        <div className="mt-2 w-full rounded-md border border-border p-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-medium">
              Restore to {kindLabel(target).toLowerCase()} · {clockTime(target.createdAt)}
            </p>
            <Button size="sm" variant="ghost" className="h-6 px-1" aria-label="Close preview" onClick={() => setTarget(null)}>
              <Icon name="X" aria-hidden />
            </Button>
          </div>
          <RestorePreview threadId={threadId} checkpoint={target} />
        </div>
      ) : null}
      {forking !== null ? <ForkDialog threadId={threadId} checkpoint={forking} open onOpenChange={(open) => !open && setForking(null)} /> : null}
    </div>
  );
}

function groupTitle(group: TurnGroup<CheckpointDto>): string {
  if (group.kind === "restore") return "Before a restore";
  if (group.kind === "manual") return group.after?.label ?? "Manual checkpoint";
  if (group.before?.label === "Thread start") return `Turn ${group.turn} · thread start`;
  return `Turn ${group.turn}`;
}

function TurnRow({ threadId, group, previous }: { threadId: string; group: TurnGroup<CheckpointDto>; previous: CheckpointDto | null }) {
  const [open, setOpen] = useState(false);
  const members = [group.before, ...group.extras, group.after].filter((entry): entry is CheckpointDto => entry !== null);
  const from = group.before?.status === "ok" ? group.before.id : previous?.id ?? null;
  const to = group.after?.status === "ok" ? group.after.id : null;
  // Stats on the after-turn checkpoint cover the whole turn when nothing
  // was taken between it and the before-turn one.
  const stats = group.after !== null && group.extras.length === 0 && group.before !== null ? group.after.stats : null;
  const running = group.kind === "turn" && group.after === null;
  const time = group.before?.createdAt ?? group.after?.createdAt ?? group.startedAt;
  const excerpt = group.excerpt ?? group.extras.find((entry) => entry.messageExcerpt !== null)?.messageExcerpt ?? null;
  const outside = turnEffectsSentence(members.flatMap((member) => member.effects ?? []));
  return (
    <li className="space-y-2 py-3">
      <button type="button" className="flex w-full min-w-0 items-start gap-2 text-left" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            {groupTitle(group)}
            <span className="text-xs font-normal text-muted-foreground">{clockTime(time)}</span>
            {running ? <Badge tone="info">in progress</Badge> : null}
            {members.map((member) => (
              <CheckpointBadges key={member.id} checkpoint={member} />
            ))}
          </span>
          {excerpt !== null ? <span className="line-clamp-2 block text-xs text-muted-foreground">“{excerpt}”</span> : null}
        </span>
        {stats !== null ? (
          <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] text-muted-foreground">
            <span>{stats.files === 0 ? "no changes" : filesLabel(stats.files)}</span>
            {stats.files > 0 ? <Counts additions={stats.insertions} deletions={stats.deletions} /> : null}
          </span>
        ) : null}
      </button>
      {outside !== null ? (
        <div className="pl-6">
          <Notice tone="warning">
            <CodeText text={outside} />
          </Notice>
        </div>
      ) : null}
      {open ? (
        <div className="space-y-2 pl-6">
          {from !== null && to !== null ? (
            <FileDiffs threadId={threadId} from={from} to={to} emptyText="This turn changed no files." />
          ) : from !== null && running ? (
            <FileDiffs threadId={threadId} from={from} to="current" emptyText="No changes yet." />
          ) : (
            <p className="text-xs text-muted-foreground">No file comparison for this entry.</p>
          )}
          {group.extras.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Also during this turn: {group.extras.map((entry) => `${kindLabel(entry).toLowerCase()} at ${clockTime(entry.createdAt)}`).join(", ")}.
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="pl-6">
        <TurnActions threadId={threadId} group={group} />
      </div>
    </li>
  );
}

function RestoreHistory({ threadId, restores }: { threadId: string; restores: RestoreDto[] }) {
  const rpc = useRewindRpc();
  const [busy, setBusy] = useState<string | null>(null);
  if (restores.length === 0) return null;
  const newestFirst = [...restores].reverse();
  // Like `bb rewind undo`: the newest restore that changed files, including
  // one that stopped part way (a failure with an undo point).
  const undoable = newestFirst.find((restore) => restore.undoneBy === null && restore.preRestoreCheckpointId !== null) ?? null;
  const undo = async (restore: RestoreDto) => {
    setBusy(restore.id);
    try {
      const outcome = await rpc.call("undo", { threadId, restoreId: restore.id });
      announceRestore(rpc, threadId, outcome, "Restore undone");
    } catch (cause) {
      toast.error(`Could not undo: ${errorMessage(cause)}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="space-y-2">
      <SectionTitle>Restores</SectionTitle>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {newestFirst.slice(0, 20).map((restore) => (
          <li key={restore.id} className="flex items-center gap-2 px-3 py-2 text-xs">
            <Icon name={restore.kind === "undo" ? "ArrowTurnBackward" : restore.kind === "fork" ? "Fork" : "RotateCcw"} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                {restore.kind === "undo" ? "Undid a restore" : restore.kind === "fork" ? "Files for a fork" : "Restored files"} · {clockTime(restore.createdAt)}
              </span>
              <span className="block truncate text-muted-foreground">
                {restore.summary === null
                  ? (restore.error ?? "")
                  : `${restore.summary.writes} written, ${restore.summary.creates} created, ${restore.summary.deletes} deleted${restore.summary.protectedCount > 0 ? `, ${restore.summary.protectedCount} left alone` : ""}`}
                {restore.undoneBy !== null ? " · undone" : ""}
              </span>
            </span>
            {restore.status === "failed" ? (
              restore.preRestoreCheckpointId === null ? <Badge tone="danger">failed</Badge> : <Badge tone="danger">incomplete</Badge>
            ) : null}
            {restore.status === "unverified" ? <Badge tone="warning">not verified</Badge> : null}
            {undoable?.id === restore.id && restore.kind !== "fork" ? (
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy !== null} onClick={() => void undo(restore)}>
                {busy === restore.id ? "Undoing…" : "Undo"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkspaceNotices({ list }: { list: ListResult }) {
  const notices = [];
  if (!list.settings.enabled) notices.push(<Notice key="off">Automatic checkpoints are off (Rewind setting). Manual checkpoints, restores, and forks still work.</Notice>);
  if (list.settings.projectExcluded) notices.push(<Notice key="excluded">This project is excluded from automatic checkpoints in Rewind's settings.</Notice>);
  if (list.workspace?.unsupported) {
    notices.push(
      <Notice key="unsupported" tone="warning">
        This workspace is too large for Rewind ({list.workspace.unsupported}), so no checkpoints are being taken. Messages are not delayed.
      </Notice>,
    );
  }
  if (list.workspaceError !== null) notices.push(<Notice key="error" tone="warning">{list.workspaceError}</Notice>);
  if (list.workspace !== null && list.workspace.sharedWith > 0) {
    notices.push(
      <Notice key="shared">
        {plural(list.workspace.sharedWith, "other thread")} {list.workspace.sharedWith === 1 ? "shares" : "share"} this workspace; restoring changes its files too.
      </Notice>,
    );
  }
  return notices.length === 0 ? null : <div className="space-y-2">{notices}</div>;
}

export function CheckpointsPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRewindRpc();
  const focus = useMemo(() => parseFocus(params), [params]);
  const list = useLoadable(threadId, () => rpc.call("list", { threadId, limit: 400 }), "list");
  const [saving, setSaving] = useState(false);
  const groups = useMemo(() => (list.data === null ? [] : groupTurns(list.data.checkpoints)), [list.data]);

  const checkpointNow = async () => {
    setSaving(true);
    try {
      const { checkpoint } = await rpc.call("checkpoint", { threadId });
      toast.success(`Checkpoint saved`, { description: checkpoint.id });
    } catch (cause) {
      toast.error(`No checkpoint was saved: ${errorMessage(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  const count = list.data?.checkpoints.filter((checkpoint) => checkpoint.status === "ok").length ?? 0;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{list.data === null ? "Checkpoints" : `${plural(count, "checkpoint")}`}</p>
          <p className="truncate text-xs text-muted-foreground" title={list.data?.workspace?.path}>
            {list.data?.workspace?.path ?? "Taken before and after every turn"}
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={saving} onClick={() => void checkpointNow()}>
          <Icon name="Plus" aria-hidden />
          {saving ? "Saving…" : "Checkpoint now"}
        </Button>
      </div>
      {list.data !== null ? <WorkspaceNotices list={list.data} /> : null}
      {focus !== null ? <FocusCard threadId={threadId} focus={focus} /> : null}
      {list.error !== null ? <Notice tone="danger">{list.error}</Notice> : null}
      {list.data === null && list.error === null ? <Spinner label="Loading checkpoints…" /> : null}
      {list.data !== null ? (
        <section className="space-y-1">
          <SectionTitle>Turns</SectionTitle>
          {groups.length === 0 ? (
            <EmptyState>No checkpoints yet. Rewind takes one before and after every turn.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {groups
                .map((group, index) => {
                  const previous = [...groups.slice(0, index)].reverse().map((entry) => entry.after ?? entry.before).find((entry) => entry?.status === "ok") ?? null;
                  return { group, previous };
                })
                .reverse()
                .map(({ group, previous }) => (
                  <TurnRow key={group.key} threadId={threadId} group={group} previous={previous} />
                ))}
            </ul>
          )}
        </section>
      ) : null}
      {list.data !== null ? <RestoreHistory threadId={threadId} restores={list.data.restores} /> : null}
    </div>
  );
}
