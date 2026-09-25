// A lazily loaded list of changed files between two states; each file
// expands to its patch in the host diff viewer. Both levels are bounded by
// the server (file count and patch bytes).
import { useState } from "react";
import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { type DiffResult, useLoadable, useRewindRpc } from "./data";
import { Counts, Spinner } from "./parts";

const STATUS_LABELS: Record<string, string> = { A: "added", M: "modified", D: "deleted", T: "type changed" };

function FilePatch({ threadId, from, to, path }: { threadId: string; from: string; to: string; path: string }) {
  const rpc = useRewindRpc();
  const patch = useLoadable(threadId, () => rpc.call("diff", { threadId, from, to, paths: [path], patch: true }), `${from}:${to}:${path}`);
  if (patch.loading && patch.data === null) return <Spinner label="Loading diff…" />;
  if (patch.error !== null) return <p className="text-xs text-destructive">{patch.error}</p>;
  const file = patch.data?.files[0];
  if (file === undefined) return <p className="text-xs text-muted-foreground">No difference any more.</p>;
  if (file.binary) return <p className="text-xs text-muted-foreground">Binary file; no text diff.</p>;
  if (file.patch === null) return <p className="text-xs text-muted-foreground">The diff is too large to show here. Use `bb rewind diff` in a terminal.</p>;
  return (
    <div className="overflow-hidden rounded-md border border-border text-xs">
      <Diff patch={file.patch} path={file.path} view="unified" overflow="scroll" />
      {file.patchTruncated ? <p className="border-t border-border px-2 py-1 text-[11px] text-muted-foreground">Diff truncated.</p> : null}
    </div>
  );
}

function FileRow({ threadId, from, to, file }: { threadId: string; from: string; to: string; file: DiffResult["files"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-1">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-state-hover"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="w-4 shrink-0 font-mono text-[11px] text-muted-foreground" title={STATUS_LABELS[file.status]}>
          {file.status}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
          {file.path}
        </span>
        <Counts additions={file.additions} deletions={file.deletions} binary={file.binary} />
      </button>
      {open ? (
        <div className="mt-1 pl-6">
          <FilePatch threadId={threadId} from={from} to={to} path={file.path} />
        </div>
      ) : null}
    </li>
  );
}

/** Files changed from `from` to `to` (checkpoint ids, "empty", or "current"). */
export function FileDiffs({ threadId, from, to, emptyText = "No file changes." }: { threadId: string; from: string; to: string; emptyText?: string }) {
  const rpc = useRewindRpc();
  const diff = useLoadable(threadId, () => rpc.call("diff", { threadId, from, to }), `${from}:${to}`);
  const [limit, setLimit] = useState(50);
  if (diff.loading && diff.data === null) return <Spinner label="Comparing files…" />;
  if (diff.error !== null) return <p className="text-xs text-destructive">{diff.error}</p>;
  const data = diff.data;
  if (data === null || data.totalFiles === 0) return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  const shown = data.files.slice(0, limit);
  return (
    <div>
      <ul className="divide-y divide-border/60">
        {shown.map((file) => (
          <FileRow key={file.path} threadId={threadId} from={from} to={to} file={file} />
        ))}
      </ul>
      {data.files.length > limit ? (
        <Button variant="ghost" size="sm" className="mt-1" onClick={() => setLimit((value) => value + 100)}>
          Show more files
        </Button>
      ) : null}
      {data.filesTruncated ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {data.totalFiles - data.files.length} more files not listed. Use `bb rewind diff --stat` for the full list.
        </p>
      ) : null}
    </div>
  );
}
