// @vitest-environment jsdom
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CheckpointDto, RestoreDto } from "../src/rpc-contract";

type App = Awaited<ReturnType<typeof loadPluginApp>>;
let app: App;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});

const mounted: Array<{ lifecycle: { unmount(): void } }> = [];
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
});

const THREAD = "thr_test0001";
const NOW = Date.now();
let counter = 0;

function checkpoint(overrides: Partial<CheckpointDto> = {}): CheckpointDto {
  counter += 1;
  return {
    id: `ck_${counter.toString().padStart(9, "0")}abcdefg`,
    threadId: THREAD,
    environmentId: "env_1",
    hostId: "host_1",
    workspace: "/work/repo",
    kind: "before-turn",
    label: null,
    attempt: "start-turn",
    status: "ok",
    late: false,
    deduped: false,
    eventMark: counter,
    messageExcerpt: null,
    commit: "a".repeat(40),
    head: { sha: "b".repeat(40), branch: "main" },
    baseline: false,
    stats: { files: 0, insertions: 0, deletions: 0 },
    changes: [],
    changesTruncated: false,
    skipped: [],
    skippedCount: 0,
    durationMs: 12,
    error: null,
    createdAt: NOW - (100 - counter) * 60_000,
    completedAt: NOW,
    effects: [],
    ...overrides,
  };
}

function restore(overrides: Partial<RestoreDto> = {}): RestoreDto {
  return {
    id: "rs_000000001aaaaaaa",
    threadId: THREAD,
    kind: "restore",
    targetCheckpointId: "ck_000000001abcdefg",
    preRestoreCheckpointId: "ck_000000099abcdefg",
    status: "ok",
    summary: { creates: 0, writes: 1, deletes: 1, protectedCount: 0, verified: true, mismatchCount: 0, untouchedCount: 0 },
    error: null,
    undoneBy: null,
    createdAt: NOW,
    ...overrides,
  };
}

const settings = { enabled: true, gateHoldMs: 200, maxFileSizeMB: 10, maxCheckpointsPerThread: 200, retentionDays: 14, projectExcluded: false };
const workspace = { environmentId: "env_1", hostId: "host_1", path: "/work/repo", isGit: true, sharedWith: 0, running: [], unsupported: null };

function scenario() {
  counter = 0;
  const base = checkpoint({ label: "Thread start", eventMark: 0, baseline: true, stats: { files: 40, insertions: 900, deletions: 0 } });
  const after1 = checkpoint({ kind: "after-turn", attempt: null, stats: { files: 1, insertions: 1, deletions: 1 } });
  const before2 = checkpoint({ messageExcerpt: "Change it to two and add extra", late: true });
  const after2 = checkpoint({
    kind: "after-turn",
    attempt: null,
    stats: { files: 2, insertions: 3, deletions: 1 },
    skipped: [{ path: "big.bin", reason: "too-large", sizeBytes: 50_000_000 }],
    skippedCount: 1,
  });
  return { base, after1, before2, after2, checkpoints: [base, after1, before2, after2] };
}

function listResult(checkpoints: CheckpointDto[], restores: RestoreDto[] = [], overrides: Record<string, unknown> = {}) {
  return { threadId: THREAD, checkpoints, restores, workspace, workspaceError: null, settings, ...overrides };
}

const diffFile = (path: string, patch: string | null = null) => ({
  path,
  status: "M" as const,
  oldMode: "100644",
  newMode: "100644",
  binary: false,
  additions: 1,
  deletions: 1,
  patch,
  patchTruncated: false,
});

function renderPanel(params: unknown, rpc: Record<string, (input: never) => unknown>, extra: Record<string, unknown> = {}) {
  const panel = app.threadPanelActions.find((action) => action.id === "checkpoints")!;
  const slot = renderSlot(panel, { threadId: THREAD, params: params as never }, { rpc: rpc as never, context: { threadId: THREAD, projectId: "proj_1" }, ...extra });
  mounted.push(slot);
  return slot;
}

describe("registrations", () => {
  it("registers the message action, panel, header control, overlay, and palette commands", () => {
    expect(app.messageActions.map((action) => [action.id, action.title])).toEqual([["rewind-to-here", "Rewind to here"]]);
    expect(app.threadPanelActions.map((action) => [action.id, action.title, action.layout])).toEqual([["checkpoints", "Checkpoints", "padded"]]);
    expect(app.threadHeaderActions.map((action) => action.id)).toEqual(["checkpoints"]);
    expect(app.appOverlays.map((overlay) => overlay.id)).toEqual(["rpc-bridge"]);
  });

  it("opens the panel focused on the message from 'Rewind to here'", async () => {
    const calls: unknown[] = [];
    await app.messageActions[0]!.run({
      threadId: THREAD,
      message: { id: "m1", threadId: THREAD, role: "user", text: "  Change it\n to two ", sourceSeqEnd: 42 },
      openPanel: (options) => {
        calls.push(options);
        return true;
      },
    });
    expect(calls).toEqual([
      {
        actionId: "checkpoints",
        title: "Rewind: before message",
        params: { focus: { role: "user", sourceSeqEnd: 42, messageThreadId: THREAD, excerpt: "Change it to two" } },
      },
    ]);
  });
});

describe("thread header control", () => {
  it("shows the checkpoint count and opens the panel", async () => {
    const header = app.threadHeaderActions[0]!;
    const slot = renderSlot(header, { threadId: THREAD, projectId: "proj_1", isCompactViewport: false }, {
      rpc: { summary: () => ({ enabled: true, count: 7, pending: 0, lastCheckpointAt: NOW }) } as never,
      openThreadPanel: () => true,
    });
    mounted.push(slot);
    const button = await slot.findByRole("button", { name: /Rewind: 7 checkpoints/u });
    expect(button.textContent).toContain("7");
    fireEvent.click(button);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "checkpoints", title: "Checkpoints" } }]);
  });

  it("refreshes when the server signals a change for its thread only", async () => {
    let count = 1;
    const slot = renderSlot(app.threadHeaderActions[0]!, { threadId: THREAD, projectId: "proj_1", isCompactViewport: true }, {
      rpc: { summary: () => ({ enabled: true, count: count++, pending: 0, lastCheckpointAt: NOW }) } as never,
    });
    mounted.push(slot);
    await slot.findByRole("button", { name: /1 checkpoint\b/u });
    await slot.behavior.emitRealtime("rewind.changed", { threadId: "thr_other" });
    await slot.behavior.emitRealtime("rewind.changed", { threadId: THREAD });
    await slot.findByRole("button", { name: /2 checkpoints/u });
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "summary")).toHaveLength(2);
  });
});

describe("Checkpoints panel", () => {
  it("lists turns newest first with excerpts, stats, and warnings", async () => {
    const { checkpoints } = scenario();
    const slot = renderPanel(null, { list: () => listResult(checkpoints) });
    await slot.findByText("Turn 2");
    const items = slot.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Turn 2");
    expect(items[0]!.textContent).toContain("Change it to two and add extra");
    expect(items[0]!.textContent).toContain("2 files");
    expect(within(items[0]!).getByText("late").getAttribute("title")).toContain("finished after its turn had started");
    expect(within(items[0]!).getByText("1 skipped").getAttribute("title")).toContain("big.bin (over the size cap)");
    expect(items[1]!.textContent).toContain("Turn 1 · thread start");
    expect(slot.getByText("4 checkpoints")).toBeTruthy();
  });

  it("says what a turn did outside the workspace that Rewind can't undo", async () => {
    const { base, after1 } = scenario();
    const slot = renderPanel(null, { list: () => listResult([base, { ...after1, effects: [{ kind: "git-push", label: "git push", command: "git push origin main" }] }]) });
    const [note] = await slot.findAllByText((_, element) => element?.textContent === "This turn ran git push; Rewind can't undo that.");
    expect(note!.querySelector("code")?.textContent).toBe("git push");
  });

  it("says a late after-turn checkpoint may include the start of the next turn", async () => {
    const { base, after1 } = scenario();
    const slot = renderPanel(null, { list: () => listResult([base, { ...after1, late: true }]) });
    const badge = await slot.findByText("late");
    expect(badge.getAttribute("title")).toContain("taken after the next turn had started");
  });

  it("expands a turn into its changed files and a file into its diff", async () => {
    const { checkpoints, before2, after2 } = scenario();
    const slot = renderPanel(null, {
      list: () => listResult(checkpoints),
      diff: (input: { from: string; to: string; paths?: string[]; patch?: boolean }) => {
        expect([input.from, input.to]).toEqual([before2.id, after2.id]);
        if (input.patch === true) {
          return { files: [diffFile("scratch.txt", "diff --git a/scratch.txt b/scratch.txt\n--- a/scratch.txt\n+++ b/scratch.txt\n@@ -1 +1 @@\n-one\n+two\n")], totalFiles: 1, filesTruncated: false, stats: { files: 1, insertions: 1, deletions: 1 } };
        }
        return { files: [diffFile("scratch.txt"), { ...diffFile("extra.txt"), status: "A" }], totalFiles: 2, filesTruncated: false, stats: { files: 2, insertions: 2, deletions: 1 } };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: /Turn 2/u }));
    fireEvent.click(await slot.findByRole("button", { name: /scratch\.txt/u }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "diff")).toHaveLength(2));
    expect(slot.getByText("extra.txt")).toBeTruthy();
    await waitFor(() => expect(slot.container.textContent).toContain("+two"));
  });

  it("shows restore history with Undo on the latest restore", async () => {
    const { checkpoints } = scenario();
    const older = restore({ id: "rs_000000001aaaaaaa", undoneBy: "rs_000000002bbbbbbb" });
    const undo = restore({ id: "rs_000000002bbbbbbb", kind: "undo" });
    const slot = renderPanel(null, {
      list: () => listResult(checkpoints, [older, undo]),
      undo: () => ({ restore: restore({ id: "rs_000000003ccccccc", kind: "undo" }), preRestore: null, plan: { creates: 0, writes: 1, deletes: 0, changes: [], changesTruncated: false, protected: [], protectedCount: 0 }, verification: { ok: true, mismatches: [], mismatchCount: 0, untouched: [], untouchedCount: 0 }, warnings: [], effects: [], note: null }),
    });
    const undoButton = await slot.findByRole("button", { name: "Undo" });
    expect(slot.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    fireEvent.click(undoButton);
    await waitFor(() => expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("undo"));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "undo")!.input).toEqual({ threadId: THREAD, restoreId: undo.id });
  });

  it("offers Undo on a restore that stopped part way, but not on one that failed before changing files", async () => {
    const { checkpoints } = scenario();
    const finished = restore({ id: "rs_000000001aaaaaaa" });
    const partial = restore({ id: "rs_000000002bbbbbbb", status: "failed", summary: null, error: "git read-tree exited 128" });
    const slot = renderPanel(null, { list: () => listResult(checkpoints, [finished, partial]) });
    await slot.findByText("incomplete");
    fireEvent.click(slot.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "undo")?.input).toEqual({ threadId: THREAD, restoreId: partial.id }));
    slot.unmount();

    const noop = restore({ id: "rs_000000003ccccccc", status: "failed", preRestoreCheckpointId: null, summary: null, error: "host went away" });
    const second = renderPanel(null, { list: () => listResult(checkpoints, [finished, noop]) });
    await second.findByText("failed");
    fireEvent.click(second.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(second.inspection.rpcCalls.find((call) => call.method === "undo")?.input).toEqual({ threadId: THREAD, restoreId: finished.id }));
  });

  it("explains an unsupported workspace and disabled automatic checkpoints", async () => {
    const slot = renderPanel(null, {
      list: () => listResult([], [], { settings: { ...settings, enabled: false }, workspace: { ...workspace, unsupported: "more than 100000 files to track" } }),
    });
    await slot.findByText(/too large for Rewind/u);
    expect(slot.getByText(/Automatic checkpoints are off/u)).toBeTruthy();
    expect(slot.getByText(/No checkpoints yet/u)).toBeTruthy();
  });

  it("takes a checkpoint on demand", async () => {
    const { checkpoints } = scenario();
    const slot = renderPanel(null, { list: () => listResult(checkpoints), checkpoint: () => ({ checkpoint: checkpoint({ kind: "manual", attempt: null }) }) });
    fireEvent.click(await slot.findByRole("button", { name: /Checkpoint now/u }));
    await waitFor(() => expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("checkpoint"));
  });
});

describe("Rewind to here", () => {
  const focusParams = { focus: { role: "user", sourceSeqEnd: 7, messageThreadId: THREAD, excerpt: "Change it to two" } };

  function focusRpc(preview: Record<string, unknown> = {}) {
    const { checkpoints, before2 } = scenario();
    return {
      before2,
      rpc: {
        list: () => listResult(checkpoints),
        resolveMessage: () => ({ match: "exact", checkpoint: before2, note: "Files as they were when this message was sent." }),
        preview: () => ({
          checkpoint: before2,
          plan: {
            creates: 0,
            writes: 1,
            deletes: 1,
            changes: [],
            changesTruncated: false,
            protected: [{ path: ".env", reason: "ignored", action: "write" }],
            protectedCount: 1,
          },
          skipped: [],
          skippedCount: 0,
          currentHead: { sha: "c".repeat(40), branch: "main" },
          headMoved: true,
          workspace,
          effects: [],
          ...preview,
        }),
        restore: () => ({
          restore: restore(),
          preRestore: checkpoint({ kind: "pre-restore", attempt: null }),
          plan: { creates: 0, writes: 1, deletes: 1, changes: [], changesTruncated: false, protected: [], protectedCount: 0 },
          verification: { ok: true, mismatches: [], mismatchCount: 0, untouched: [], untouchedCount: 0 },
          warnings: [],
          effects: [],
          note: null,
        }),
        stopRunning: () => ({ stopped: ["thr_other001"] }),
      },
    };
  }

  it("resolves the message, previews the restore with warnings, and restores after confirmation", async () => {
    const { rpc, before2 } = focusRpc();
    const slot = renderPanel(focusParams, rpc);
    await slot.findByRole("heading", { name: /Rewind to before this message/u });
    expect(slot.getByText("“Change it to two”")).toBeTruthy();
    await slot.findByText(/Restoring changes 2 files: 1 written, 0 created, 1 deleted/u);
    expect(slot.getByText(/Git HEAD moved since this checkpoint/u)).toBeTruthy();
    expect(slot.getByText(/may already include some of that turn's edits/u)).toBeTruthy();
    expect(slot.getByText(".env")).toBeTruthy();
    expect(slot.inspection.rpcCalls.find((call) => call.method === "resolveMessage")!.input).toEqual({
      threadId: THREAD,
      message: { role: "user", sourceSeqEnd: 7, threadId: THREAD },
    });

    const focusCard = slot.getByRole("region", { name: /Rewind to before this message/u });
    fireEvent.click(within(focusCard).getByRole("button", { name: /Restore files/u }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore files" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("restore"));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "restore")!.input).toEqual({ threadId: THREAD, checkpointId: before2.id });
  });

  it("restores the files and edits the message, saying what can and cannot be undone", async () => {
    const { rpc, before2 } = focusRpc();
    const outcome = (rpc.restore as () => Record<string, unknown>)();
    const slot = renderPanel(focusParams, {
      ...rpc,
      resolveMessage: () => ({
        match: "exact",
        checkpoint: before2,
        note: "Files as they were when this message was sent.",
        message: { number: 2, text: "Change it to two", editable: true },
      }),
      editMessage: () => ({ outcome, edit: { ok: true, requestSequence: 12, message: 2 } }),
    });
    const focusCard = await slot.findByRole("region", { name: /Rewind to before this message/u });
    fireEvent.click(await within(focusCard).findByRole("button", { name: "Restore files and edit this message" }));
    const dialog = await slot.findByRole("dialog");
    expect(within(dialog).getByText(/That part can be undone, like any restore/u)).toBeTruthy();
    expect(within(dialog).getByText(/Rewind cannot undo it/u)).toBeTruthy();
    const box = within(dialog).getByRole("textbox", { name: "New message" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Change it to two");
    fireEvent.change(box, { target: { value: "Change it to three" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore and edit" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.find((call) => call.method === "editMessage")?.input).toEqual({ threadId: THREAD, sourceSeqEnd: 7, text: "Change it to three" }),
    );
  });

  it("warns in the preview about commands in the undone turns that reached outside the workspace", async () => {
    const { rpc } = focusRpc({
      effects: [
        { kind: "git-push", label: "git push", command: "git push origin main", turn: 2 },
        { kind: "publish", label: "npm publish", command: "npm publish", turn: null },
      ],
    });
    const slot = renderPanel(focusParams, rpc);
    const [note] = await slot.findAllByText(
      (_, element) => element?.textContent === "Turn 2 ran git push; the latest turn ran npm publish. Rewind can't undo those. Restoring puts back the files only.",
    );
    expect(Array.from(note!.querySelectorAll("code"), (code) => code.textContent)).toEqual(["git push", "npm publish"]);
  });

  it("offers editing only for messages bb can edit, and says why not otherwise", async () => {
    const { rpc, before2 } = focusRpc();
    const slot = renderPanel(focusParams, rpc);
    const focusCard = await slot.findByRole("region", { name: /Rewind to before this message/u });
    await within(focusCard).findByRole("button", { name: "Restore files" });
    expect(within(focusCard).queryByRole("button", { name: "Restore files and edit this message" })).toBeNull();

    const noEdit = renderPanel(focusParams, {
      ...rpc,
      resolveMessage: () => ({ match: "exact", checkpoint: before2, note: "", message: { number: 2, text: "Change it to two", editable: false } }),
    });
    const card = await noEdit.findAllByRole("region", { name: /Rewind to before this message/u });
    await within(card.at(-1)!).findByText(/cannot replace a message, so after a restore Rewind suggests a note/u);
    expect(within(card.at(-1)!).queryByRole("button", { name: "Restore files and edit this message" })).toBeNull();
  });

  it("refuses to restore while a thread runs and offers to stop it", async () => {
    const { rpc } = focusRpc({ workspace: { ...workspace, running: [{ id: "thr_other001", title: "Other agent", status: "active", isSelf: false }] } });
    const slot = renderPanel(focusParams, rpc);
    await slot.findByText(/Not restoring while Other agent is running/u);
    const focusCard = slot.getByRole("region", { name: /Rewind to before this message/u });
    expect((within(focusCard).getByRole("button", { name: /Restore files/u }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(focusCard).getByRole("button", { name: /Stop it and restore/u }));
    await waitFor(() => expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(expect.arrayContaining(["stopRunning", "restore"])));
    const methods = slot.inspection.rpcCalls.map((call) => call.method);
    expect(methods.indexOf("stopRunning")).toBeLessThan(methods.indexOf("restore"));
  });

  it("says so when no checkpoint covers the message", async () => {
    const slot = renderPanel(focusParams, {
      list: () => listResult([]),
      resolveMessage: () => ({ match: "none", checkpoint: null, note: "No checkpoint was taken before this message." }),
    });
    await slot.findByText("No checkpoint was taken before this message.");
  });

  it("ignores malformed panel params", async () => {
    const slot = renderPanel({ focus: { role: "system", sourceSeqEnd: -1 } }, { list: () => listResult([]) });
    await slot.findByText(/No checkpoints yet/u);
    expect(slot.queryByRole("region")).toBeNull();
  });
});

describe("palette commands", () => {
  type Command = { id: string; title: string; run: (context: unknown) => unknown; isAvailable?: (context: unknown) => boolean };

  /** loadPluginApp does not capture commands; run setup against a builder that does. */
  async function captureCommands(): Promise<Command[]> {
    const definition = (await import("../app")).default as unknown as { setup: (builder: unknown) => void };
    const commands: Command[] = [];
    const noop = new Proxy({}, { get: () => () => undefined });
    definition.setup({
      commands: { register: (command: Command) => commands.push(command) },
      slots: noop,
      composer: noop,
      contentScripts: noop,
      experimental_icons: noop,
      experimental_sidebarFooter: noop,
    });
    return commands;
  }

  it("registers self-identifying commands that need a thread", async () => {
    const commands = await captureCommands();
    expect(commands.map((command) => command.title)).toEqual(["Rewind: open checkpoints", "Rewind: checkpoint now"]);
    for (const command of commands) {
      expect(command.isAvailable?.({ threadId: null, projectId: null, openPanel: () => false })).toBe(false);
      expect(command.isAvailable?.({ threadId: THREAD, projectId: null, openPanel: () => false })).toBe(true);
    }
    const opened: unknown[] = [];
    await commands[0]!.run({ threadId: THREAD, projectId: null, openPanel: (options: unknown) => opened.push(options) > 0 });
    expect(opened).toEqual([{ actionId: "checkpoints", title: "Checkpoints" }]);
  });

  it("checkpoints the current thread through the app-wide RPC bridge", async () => {
    const overlay = renderSlot(app.appOverlays[0]!, {}, { rpc: { checkpoint: () => ({ checkpoint: checkpoint({ kind: "manual" }) }) } as never });
    mounted.push(overlay);
    const checkpointNow = (await captureCommands()).find((command) => command.id === "checkpoint-now")!;
    await checkpointNow.run({ threadId: THREAD, projectId: null, openPanel: () => false });
    expect(overlay.inspection.rpcCalls).toEqual([{ method: "checkpoint", input: { threadId: THREAD } }]);
  });
});

describe("note above the message box", () => {
  const text = "Files were restored to before message 2 (“Change it to two”); turn 2 was undone. Re-read files before editing.";
  const banner = () => app.composerCustomizations.find((customization) => customization.id === "restore-note")!.banners![0]!;

  function renderBanner(note: { text: string; createdAt: number } | null, draft = "") {
    const slot = renderSlot(banner(), {}, {
      rpc: { note: () => ({ note }), dismissNote: () => ({ dismissed: true }) } as never,
      composer: { scope: { kind: "thread", threadId: THREAD }, text: draft },
    });
    mounted.push(slot);
    return slot;
  }

  it("is registered for thread message boxes", () => {
    expect(app.composerCustomizations.map((customization) => [customization.id, customization.scopes])).toEqual([["restore-note", ["thread"]]]);
  });

  it("inserts the suggested note ahead of the draft, never sending it", async () => {
    const slot = renderBanner({ text, createdAt: NOW }, "and then fix the tests");
    await slot.findByText(/Suggested note for your next message/u);
    fireEvent.click(slot.getByRole("button", { name: "Insert" }));
    expect(slot.inspection.composer.text).toBe(`${text}\n\nand then fix the tests`);
    await waitFor(() => expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("dismissNote"));
    expect(slot.queryByText(/Suggested note/u)).toBeNull();
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("can be dismissed, and shows nothing without a note", async () => {
    const slot = renderBanner({ text, createdAt: NOW });
    await slot.findByText(/Suggested note/u);
    fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(slot.queryByText(/Suggested note/u)).toBeNull());
    const empty = renderBanner(null);
    await waitFor(() => expect(empty.inspection.rpcCalls.map((call) => call.method)).toContain("note"));
    expect(empty.container.textContent).toBe("");
  });
});
