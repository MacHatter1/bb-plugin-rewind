// Rewind — frontend entry. Compiled by `bb plugin build`; React and the SDK
// app module come from BB at runtime.
//
// Surfaces: "Rewind to here" on every chat message, the Checkpoints thread
// panel, a checkpoint count in the thread header, a note banner above the
// message box after a restore, and two palette commands.
import { useEffect } from "react";
import { toast } from "sonner";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PANEL_ACTION_ID } from "./src/constants";
import { type Rpc, useRewindRpc } from "./src/ui/data";
import { HeaderButton } from "./src/ui/HeaderButton";
import { errorMessage } from "./src/ui/labels";
import { RestoreNoteBanner } from "./src/ui/NoteBanner";
import { CheckpointsPanel } from "./src/ui/Panel";

// Palette commands run outside React, so they borrow the RPC client of an
// invisible app-wide component. Not per-thread state: just the client.
let rpcBridge: Rpc | null = null;

function RpcBridge() {
  const rpc = useRewindRpc();
  useEffect(() => {
    rpcBridge = rpc;
    return () => {
      if (rpcBridge === rpc) rpcBridge = null;
    };
  }, [rpc]);
  return null;
}

function excerpt(text: string): string | null {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Checkpoints",
    icon: "RotateCcw",
    component: CheckpointsPanel,
    layout: "padded",
    run: ({ openPanel }) => {
      openPanel({ title: "Checkpoints" });
    },
  });

  app.slots.messageAction({
    id: "rewind-to-here",
    title: "Rewind to here",
    icon: "RotateCcw",
    run: ({ message, openPanel }) => {
      const opened = openPanel({
        actionId: PANEL_ACTION_ID,
        title: message.role === "user" ? "Rewind: before message" : "Rewind: after reply",
        params: {
          focus: {
            role: message.role,
            sourceSeqEnd: message.sourceSeqEnd,
            messageThreadId: message.threadId,
            excerpt: excerpt(message.text),
          },
        },
      });
      if (!opened) toast.error("Open this thread in the main view to rewind it.");
    },
  });

  app.slots.experimental_threadHeaderAction({
    id: "checkpoints",
    title: "Rewind checkpoints",
    component: HeaderButton,
  });

  app.slots.experimental_appOverlay({ id: "rpc-bridge", component: RpcBridge });

  // After a restore that left the conversation as it was: a suggested note
  // for the next message, above the thread's message box.
  app.composer.customize({
    id: "restore-note",
    scopes: ["thread"],
    banners: [{ id: "restore-note", chrome: "card", component: RestoreNoteBanner }],
  });

  app.commands.register({
    id: "open-checkpoints",
    title: "Rewind: open checkpoints",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      if (!openPanel({ actionId: PANEL_ACTION_ID, title: "Checkpoints" })) toast.error("Open a thread first.");
    },
  });

  app.commands.register({
    id: "checkpoint-now",
    title: "Rewind: checkpoint now",
    isAvailable: ({ threadId }) => threadId !== null,
    run: async ({ threadId }) => {
      if (threadId === null) return;
      const rpc = rpcBridge;
      if (rpc === null) {
        toast.error("Rewind is still loading; try again in a moment.");
        return;
      }
      const saving = rpc.call("checkpoint", { threadId });
      toast.promise(saving, {
        loading: "Saving a checkpoint…",
        success: ({ checkpoint }) => `Checkpoint saved (${checkpoint.id})`,
        error: (cause: unknown) => `No checkpoint was saved: ${errorMessage(cause)}`,
      });
      await saving.catch(() => undefined);
    },
  });
});
