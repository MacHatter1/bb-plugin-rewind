// Rewind — host entry. Runs on the machine that holds a thread's workspace
// and keeps one shadow git repository per workspace in the plugin's host data
// directory. All git work for a workspace is serialized by its shadow key.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./src/host-contract";
import { createHostHandlers } from "./src/host/handlers";
import { killAllGit } from "./src/host/git";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: createHostHandlers(),
  dispose: () => {
    killAllGit();
  },
});
