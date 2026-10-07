// A card above a thread's message box after a restore that left the
// conversation as it was: the suggested note, with Insert and Dismiss. Rewind
// never sends it; Insert only puts it in the draft.
import { useState } from "react";
import { toast } from "sonner";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useLoadable, useRewindRpc } from "./data";
import { errorMessage } from "./labels";

export function RestoreNoteBanner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : "";
  const rpc = useRewindRpc();
  const note = useLoadable(threadId, () => (threadId === "" ? Promise.resolve({ note: null }) : rpc.call("note", { threadId })), "note");
  const [hidden, setHidden] = useState<string | null>(null);
  const current = note.data?.note ?? null;
  if (threadId === "" || current === null || hidden === current.text) return null;

  const dismiss = async () => {
    setHidden(current.text);
    try {
      await rpc.call("dismissNote", { threadId });
    } catch (cause) {
      toast.error(`Could not dismiss the note: ${errorMessage(cause)}`);
    }
  };
  const insert = () => {
    composer.updateText((draft) => (draft.trim().length === 0 ? current.text : `${current.text}\n\n${draft}`));
    composer.focus();
    void dismiss();
  };
  return (
    <div className="@container min-w-0 space-y-2.5 p-3 text-xs text-foreground" role="note" aria-label="Rewind note for your next message">
      <div className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-start gap-x-2.5 gap-y-1">
        <span className="col-start-1 row-start-1 flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary @sm:row-span-2">
          <Icon name="RotateCcw" className="size-4" aria-hidden />
        </span>
        <div className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-[13px] font-semibold leading-5">Files restored</h3>
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/20 bg-warning/5 px-2 py-0.5 text-[11px] font-medium text-foreground">
            <Icon name="MessageSquare" className="size-3 text-warning-text" aria-hidden />
            Chat unchanged
          </span>
        </div>
        <Button type="button" size="sm" variant="ghost" className="col-start-3 row-start-1 size-8 p-0 text-muted-foreground focus-visible:ring-2 @sm:row-span-2" aria-label="Dismiss note" onClick={() => void dismiss()}>
          <Icon name="X" className="size-3.5" aria-hidden />
        </Button>
        <p className="col-span-3 row-start-2 text-muted-foreground leading-relaxed @sm:col-span-1 @sm:col-start-2">
          The chat still includes the undone turns. Keep the agent in sync with your files.
        </p>
      </div>
      <div className="space-y-1.5 rounded-md border border-border bg-muted/40 px-3 py-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-foreground/90">Suggested note</p>
        <blockquote className="border-l-2 border-primary/30 pl-2.5 leading-relaxed [overflow-wrap:anywhere]">
          {current.text}
        </blockquote>
      </div>
      <div className="flex flex-col gap-2 @sm:flex-row @sm:items-center @sm:justify-between">
        <p className="text-[11px] text-muted-foreground">Only adds to your draft. Nothing is sent.</p>
        <Button type="button" size="sm" className="h-8 w-full gap-1.5 px-3 text-xs focus-visible:ring-2 @sm:w-auto" onClick={insert}>
          <Icon name="ArrowDown" className="size-3.5" aria-hidden />
          Insert note
        </Button>
      </div>
    </div>
  );
}
