import { describe, expect, it } from "vitest";
import { indexEntryCount, parseDiffTree, parseStatusV2, splitPatch } from "../../src/host/parse";

const nul = (...records: string[]) => Buffer.from(records.map((record) => `${record}\0`).join(""), "latin1");

describe("git output parsers", () => {
  it("parses porcelain v2 status records, including paths with spaces", () => {
    const output = nul(
      "1 .M N... 100644 100644 100644 aaaa aaaa src/my file.ts",
      "1 .D N... 100644 100644 000000 bbbb bbbb gone.txt",
      "? new dir/new.txt",
      "? nested-repo/",
      "! ignored.log",
      "# branch.oid abc",
    );
    expect(parseStatusV2(output)).toEqual([
      { kind: "changed", x: ".", y: "M", path: "src/my file.ts" },
      { kind: "changed", x: ".", y: "D", path: "gone.txt" },
      { kind: "untracked", path: "new dir/new.txt" },
      { kind: "untracked", path: "nested-repo/" },
      { kind: "ignored", path: "ignored.log" },
    ]);
  });

  it("keeps non-UTF-8 path bytes intact", () => {
    const raw = Buffer.concat([Buffer.from("? caf"), Buffer.from([0xe9]), Buffer.from(".txt\0")]);
    const [entry] = parseStatusV2(raw);
    expect(Buffer.from(entry!.path, "latin1")).toEqual(Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(".txt")]));
  });

  it("parses raw plus numstat diff-tree output", () => {
    const output = nul(
      ":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M",
      "a.txt",
      ":000000 100644 0000000000000000000000000000000000000000 3333333333333333333333333333333333333333 A",
      "img.png",
      ":100644 120000 4444444444444444444444444444444444444444 5555555555555555555555555555555555555555 T",
      "link",
      "3\t1\ta.txt",
      "-\t-\timg.png",
      "1\t1\tlink",
    );
    expect(parseDiffTree(output)).toEqual([
      {
        path: "a.txt",
        status: "M",
        oldMode: "100644",
        newMode: "100644",
        oldSha: "1111111111111111111111111111111111111111",
        newSha: "2222222222222222222222222222222222222222",
        binary: false,
        additions: 3,
        deletions: 1,
      },
      {
        path: "img.png",
        status: "A",
        oldMode: null,
        newMode: "100644",
        oldSha: null,
        newSha: "3333333333333333333333333333333333333333",
        binary: true,
        additions: null,
        deletions: null,
      },
      {
        path: "link",
        status: "T",
        oldMode: "100644",
        newMode: "120000",
        oldSha: "4444444444444444444444444444444444444444",
        newSha: "5555555555555555555555555555555555555555",
        binary: false,
        additions: 1,
        deletions: 1,
      },
    ]);
  });

  it("splits a combined patch into per-file sections", () => {
    const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+diff --git not a header\ndiff --git a/b b/b\nnew file mode 100644\n";
    expect(splitPatch(patch)).toEqual([
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+diff --git not a header\n",
      "diff --git a/b b/b\nnew file mode 100644\n",
    ]);
    expect(splitPatch("")).toEqual([]);
  });

  it("reads the entry count from an index header", () => {
    const header = Buffer.alloc(12);
    header.write("DIRC", 0, "latin1");
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(1234, 8);
    expect(indexEntryCount(header)).toBe(1234);
    expect(indexEntryCount(Buffer.from("not an index"))).toBe(0);
  });
});
