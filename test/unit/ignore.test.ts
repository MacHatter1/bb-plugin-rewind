import { describe, expect, it } from "vitest";
import { anchoredPattern, composeExcludeFile, rebaseIgnoreLine } from "../../src/host/ignore";

describe("re-basing ignore rules onto a subdirectory workspace", () => {
  it("keeps rules unchanged when the workspace is the base directory", () => {
    expect(rebaseIgnoreLine("/build/", "")).toBe("/build/");
    expect(rebaseIgnoreLine("*.log", "")).toBe("*.log");
  });

  it("drops comments and blank lines", () => {
    expect(rebaseIgnoreLine("# a comment", "pkg")).toBeNull();
    expect(rebaseIgnoreLine("   ", "pkg")).toBeNull();
  });

  it("keeps slash-free patterns, which match at any depth", () => {
    expect(rebaseIgnoreLine("node_modules", "packages/app")).toBe("node_modules");
    expect(rebaseIgnoreLine("*.tmp", "packages/app")).toBe("*.tmp");
    expect(rebaseIgnoreLine("dist/", "packages/app")).toBe("dist/");
    expect(rebaseIgnoreLine("!keep.tmp", "packages/app")).toBe("!keep.tmp");
  });

  it("strips the workspace prefix from anchored patterns", () => {
    expect(rebaseIgnoreLine("/packages/app/build/", "packages/app")).toBe("/build/");
    expect(rebaseIgnoreLine("packages/app/src/gen.ts", "packages/app")).toBe("/src/gen.ts");
    expect(rebaseIgnoreLine("!/packages/app/build/keep", "packages/app")).toBe("!/build/keep");
    expect(rebaseIgnoreLine("packages/*/coverage", "packages/app")).toBe("/coverage");
  });

  it("drops anchored patterns for other directories", () => {
    expect(rebaseIgnoreLine("/packages/other/build/", "packages/app")).toBeNull();
    expect(rebaseIgnoreLine("/top-level.txt", "packages/app")).toBeNull();
  });

  it("does not ignore the whole workspace because an ancestor rule names it", () => {
    expect(rebaseIgnoreLine("/packages/app", "packages/app")).toBeNull();
    expect(rebaseIgnoreLine("packages/", "packages/app")).toBe("packages/");
  });

  it("keeps ** patterns matching anywhere below", () => {
    expect(rebaseIgnoreLine("**/cache", "packages/app")).toBe("**/cache");
    expect(rebaseIgnoreLine("packages/**/cache", "packages/app")).toBe("**/cache");
  });

  it("composes a managed exclude file", () => {
    const content = composeExcludeFile(
      [
        { label: "core.excludesFile", content: ".DS_Store\n# comment\n", prefix: "" },
        { label: ".gitignore above", content: "/packages/app/out/\n/elsewhere\n", prefix: "packages/app" },
      ],
      ["/.rewind-data/"],
    );
    expect(content).toBe(
      "# Managed by Rewind. Rewritten before every snapshot; do not edit.\n# From core.excludesFile\n.DS_Store\n# From .gitignore above\n/out/\n# Rewind's own storage inside this workspace\n/.rewind-data/\n",
    );
  });

  it("escapes glob characters in exact paths", () => {
    expect(anchoredPattern("a*b/[x]!.txt", false)).toBe("/a\\*b/\\[x\\]\\!.txt");
    expect(anchoredPattern("dir", true)).toBe("/dir/");
    expect(anchoredPattern("bad\nname", false)).toBeNull();
  });
});
