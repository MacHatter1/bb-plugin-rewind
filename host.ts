// Rewind — host entry. Runs on the machine that holds a thread's workspace
// and keeps one shadow git repository per workspace in the plugin's host data
// directory. Workspace work is serialized by canonical directory identity.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./src/host-contract";
import { createHostHandlers, disposeHostHandlers } from "./src/host/handlers";
import { killAllGit } from "./src/host/git";

const handlers = createHostHandlers();
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers,
  dispose: async () => {
    killAllGit();
    await disposeHostHandlers(handlers);
  },
});
