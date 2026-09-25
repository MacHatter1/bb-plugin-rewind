import { describe, expect, it } from "vitest";
import type { TreeChange } from "../../src/host/parse";
import { planRestore, type EntryKind, type PlanProbe } from "../../src/host/plan";

function change(path: string, status: TreeChange["status"]): TreeChange {
  return {
    path,
    status,
    oldMode: status === "A" ? null : "100644",
    newMode: status === "D" ? null : "100644",
    oldSha: status === "A" ? null : "a".repeat(40),
    newSha: status === "D" ? null : "b".repeat(40),
    binary: false,
    additions: 1,
    deletions: 1,
  };
}

function probe(fs: Record<string, EntryKind>, options: { uncaptured?: string[]; ignored?: string[]; unknown?: string[]; caseInsensitive?: boolean } = {}): PlanProbe {
  return {
    kind: async (path) => fs[path] ?? null,
    hasUncaptured: async (directory) => (options.uncaptured ?? []).includes(directory),
    userIgnored: async () => ({ ignored: new Set(options.ignored ?? []), unknown: new Set(options.unknown ?? []) }),
    caseInsensitive: options.caseInsensitive ?? false,
  };
}

describe("restore planning", () => {
  it("applies writes, creates, and deletes of captured paths", async () => {
    const plan = await planRestore([change("a", "M"), change("b", "D"), change("c", "A")], probe({ a: "file", b: "file" }));
    expect(plan.apply.map((entry) => [entry.path, entry.action])).toEqual([
      ["a", "write"],
      ["b", "delete"],
      ["c", "create"],
    ]);
    expect(plan.protect).toEqual([]);
  });

  it("protects an existing uncaptured file at a path the checkpoint creates", async () => {
    const plan = await planRestore([change("big.bin", "A")], probe({ "big.bin": "file" }));
    expect(plan.protect).toMatchObject([{ path: "big.bin", reason: "exists-uncaptured", action: "create" }]);
    expect(plan.dropFromTarget).toEqual(["big.bin"]);
  });

  it("protects creates under an uncaptured file or symlink", async () => {
    const plan = await planRestore([change("linked/file.txt", "A")], probe({ linked: "symlink" }));
    expect(plan.protect).toMatchObject([{ path: "linked/file.txt", reason: "blocked-by-uncaptured" }]);
  });

  it("creates under a captured symlink that the restore removes, without looking through it", async () => {
    const plan = await planRestore([change("dir", "D"), change("dir/secret.txt", "A")], probe({ dir: "symlink", "dir/secret.txt": "file" }));
    expect(plan.protect).toEqual([]);
    expect(plan.apply.map((entry) => entry.path)).toEqual(["dir", "dir/secret.txt"]);
  });

  it("keeps a directory with uncaptured files, and the captured files inside it", async () => {
    const plan = await planRestore([change("x", "A"), change("x/tracked.txt", "D")], probe({ x: "dir", "x/tracked.txt": "file" }, { uncaptured: ["x"] }));
    expect(plan.protect.map((entry) => [entry.path, entry.reason])).toEqual([
      ["x", "directory-has-uncaptured"],
      ["x/tracked.txt", "directory-has-uncaptured"],
    ]);
    expect(plan.keepCurrent.map((entry) => entry.path)).toEqual(["x/tracked.txt"]);
    expect(plan.apply).toEqual([]);
  });

  it("replaces a directory whose files are all captured", async () => {
    const plan = await planRestore([change("x", "A"), change("x/tracked.txt", "D")], probe({ x: "dir", "x/tracked.txt": "file" }));
    expect(plan.protect).toEqual([]);
    expect(plan.apply).toHaveLength(2);
  });

  it("leaves paths the repository ignores alone, whatever the change", async () => {
    const plan = await planRestore([change(".env", "M"), change("secret.key", "D"), change("new.log", "A")], probe({ ".env": "file", "secret.key": "file" }, { ignored: [".env", "secret.key", "new.log"] }));
    expect(plan.apply).toEqual([]);
    expect(plan.protect.map((entry) => [entry.path, entry.reason, entry.action]).sort()).toEqual([
      [".env", "ignored", "write"],
      ["new.log", "ignored", "create"],
      ["secret.key", "ignored", "delete"],
    ]);
    expect(plan.keepCurrent.map((entry) => entry.path).sort()).toEqual([".env", "secret.key"]);
  });

  it("leaves existing paths git cannot check alone, but still creates missing ones", async () => {
    const plan = await planRestore([change("sub/file", "M"), change("other/new", "A")], probe({ sub: "dir", "sub/file": "file" }, { unknown: ["sub/file", "other/new"] }));
    expect(plan.protect.map((entry) => [entry.path, entry.reason])).toEqual([["sub/file", "unverifiable"]]);
    expect(plan.apply.map((entry) => entry.path)).toEqual(["other/new"]);
  });

  it("treats a case-only rename as a replacement on case-insensitive filesystems", async () => {
    const plan = await planRestore([change("readme.md", "D"), change("README.md", "A")], probe({ "readme.md": "file", "README.md": "file" }, { caseInsensitive: true }));
    expect(plan.protect).toEqual([]);
    expect(plan.apply).toHaveLength(2);
  });
});
