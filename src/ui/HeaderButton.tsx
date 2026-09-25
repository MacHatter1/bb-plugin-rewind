// Thread header control: the checkpoint count; opens the Checkpoints panel.
import { useBbNavigate, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { PANEL_ACTION_ID } from "../constants";
import { useLoadable, useRewindRpc } from "./data";
import { plural } from "./labels";

export function HeaderButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRewindRpc();
  const navigate = useBbNavigate();
  const summary = useLoadable(threadId, () => rpc.call("summary", { threadId }), "summary");
  const count = summary.data?.count ?? null;
  const pending = (summary.data?.pending ?? 0) > 0;
  const enabled = summary.data?.enabled ?? true;
  const label =
    count === null
      ? "Rewind checkpoints"
      : `Rewind: ${plural(count, "checkpoint")}${pending ? ", one being captured" : ""}${enabled ? "" : " (automatic checkpoints off)"}. Open the Checkpoints panel`;
  return (
    <span title={label} className="inline-flex">
      <Button
        variant="ghost"
        size="sm"
        className={cn("h-7 gap-1.5 px-2 text-xs", !enabled && "opacity-60")}
        aria-label={label}
        onClick={() => {
          navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: "Checkpoints" });
        }}
      >
        <Icon name={pending ? "Loading" : "RotateCcw"} className={cn("size-4", pending && "animate-spin")} aria-hidden />
        {!isCompactViewport && count !== null ? <span className="tabular-nums">{count}</span> : null}
      </Button>
    </span>
  );
}
