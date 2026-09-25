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
    <div className="flex items-start gap-2 text-xs" role="note" aria-label="Rewind note for your next message">
      <Icon name="RotateCcw" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium">Files were restored, but this conversation still has the undone turns.</p>
        <p className="text-muted-foreground">Suggested note for your next message: “{current.text}”</p>
      </div>
      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={insert}>
        Insert
      </Button>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void dismiss()}>
        Dismiss
      </Button>
    </div>
  );
}
