// Parsers for git's NUL-separated plumbing output. Paths stay in the
// host-internal byte-string form (see git.ts) so non-UTF-8 names round-trip.
import type { ChangeStatus } from "../host-contract";
import { splitNul, toInternal } from "./git";

export type StatusEntry =
  | { kind: "changed"; x: string; y: string; path: string }
  | { kind: "untracked"; path: string }
  | { kind: "ignored"; path: string }
  | { kind: "unmerged"; path: string };

/** Skip `count` space-separated fields and return the remainder (the path). */
function afterFields(record: Buffer, count: number): Buffer | null {
  let offset = 0;
  for (let field = 0; field < count; field += 1) {
    const space = record.indexOf(0x20, offset);
    if (space === -1) return null;
    offset = space + 1;
  }
  return record.subarray(offset);
}

/** `git status --porcelain=v2 -z` */
export function parseStatusV2(output: Buffer): StatusEntry[] {
  const records = splitNul(output);
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 2) continue;
    const tag = String.fromCharCode(record[0]!);
    if (tag === "#") continue;
    if (tag === "?" || tag === "!") {
      const path = toInternal(record.subarray(2));
      entries.push(tag === "?" ? { kind: "untracked", path } : { kind: "ignored", path });
      continue;
    }
    const xy = record.subarray(2, 4).toString("latin1");
    const x = xy[0] ?? ".";
    const y = xy[1] ?? ".";
    if (tag === "1") {
      const path = afterFields(record, 8);
      if (path !== null) entries.push({ kind: "changed", x, y, path: toInternal(path) });
    } else if (tag === "2") {
      // Renames are disabled, but stay correct if one appears: the original
      // path follows as its own record.
      const path = afterFields(record, 9);
      if (path !== null) entries.push({ kind: "changed", x, y, path: toInternal(path) });
      const original = records[index + 1];
      index += 1;
      if (original !== undefined) entries.push({ kind: "changed", x: "D", y: "D", path: toInternal(original) });
    } else if (tag === "u") {
      const path = afterFields(record, 10);
      if (path !== null) entries.push({ kind: "unmerged", path: toInternal(path) });
    }
  }
  return entries;
}

export interface TreeChange {
  path: string;
  status: ChangeStatus;
  oldMode: string | null;
  newMode: string | null;
  oldSha: string | null;
  newSha: string | null;
  binary: boolean;
  additions: number | null;
  deletions: number | null;
}

const NULL_MODE = "000000";
const NULL_SHA = /^0+$/u;

function normalizeStatus(letter: string): ChangeStatus {
  if (letter === "A" || letter === "D" || letter === "T") return letter;
  return "M";
}

/**
 * `git diff-tree -r -z --no-renames --raw --numstat A B`. Raw records start
 * with ":" and are followed by their path record; numstat records are
 * `added\tdeleted\tpath` in one record ("-" for binary files).
 */
export function parseDiffTree(output: Buffer): TreeChange[] {
  const records = splitNul(output);
  const byPath = new Map<string, TreeChange>();
  const order: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length === 0) continue;
    if (record[0] === 0x3a /* ":" */) {
      const header = record.subarray(1).toString("latin1").split(" ");
      const pathRecord = records[index + 1];
      index += 1;
      if (pathRecord === undefined || header.length < 5) continue;
      const [oldMode, newMode, oldSha, newSha, letter] = header as [string, string, string, string, string];
      const path = toInternal(pathRecord);
      const change: TreeChange = {
        path,
        status: normalizeStatus(letter.charAt(0)),
        oldMode: oldMode === NULL_MODE ? null : oldMode,
        newMode: newMode === NULL_MODE ? null : newMode,
        oldSha: NULL_SHA.test(oldSha) ? null : oldSha,
        newSha: NULL_SHA.test(newSha) ? null : newSha,
        binary: false,
        additions: null,
        deletions: null,
      };
      const existing = byPath.get(path);
      if (existing === undefined) {
        order.push(path);
        byPath.set(path, change);
      } else {
        byPath.set(path, { ...change, binary: existing.binary, additions: existing.additions, deletions: existing.deletions });
      }
      continue;
    }
    const firstTab = record.indexOf(0x09);
    const secondTab = firstTab === -1 ? -1 : record.indexOf(0x09, firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const added = record.subarray(0, firstTab).toString("latin1");
    const deleted = record.subarray(firstTab + 1, secondTab).toString("latin1");
    const path = toInternal(record.subarray(secondTab + 1));
    const binary = added === "-" || deleted === "-";
    const counts = {
      binary,
      additions: binary ? null : Number.parseInt(added, 10),
      deletions: binary ? null : Number.parseInt(deleted, 10),
    };
    const existing = byPath.get(path);
    if (existing === undefined) {
      order.push(path);
      byPath.set(path, {
        path,
        status: "M",
        oldMode: null,
        newMode: null,
        oldSha: null,
        newSha: null,
        ...counts,
      });
    } else {
      byPath.set(path, { ...existing, ...counts });
    }
  }
  return order.map((path) => byPath.get(path)!);
}

/**
 * Split a combined `git diff-tree -p` output into per-file chunks. Every file
 * section starts with a `diff --git ` line; hunk content lines always carry a
 * ` `, `+`, or `-` prefix, so the marker cannot appear inside a hunk.
 */
export function splitPatch(output: string): string[] {
  if (output.length === 0) return [];
  const chunks: string[] = [];
  let start = output.startsWith("diff --git ") ? 0 : output.indexOf("\ndiff --git ");
  if (start === -1) return [output];
  if (start > 0) start += 1;
  for (;;) {
    const next = output.indexOf("\ndiff --git ", start);
    if (next === -1) {
      chunks.push(output.slice(start));
      return chunks;
    }
    chunks.push(output.slice(start, next + 1));
    start = next + 1;
  }
}

/** Entry count from a git index file header (`DIRC`, version, count). */
export function indexEntryCount(header: Buffer): number {
  if (header.length < 12 || header.toString("latin1", 0, 4) !== "DIRC") return 0;
  return header.readUInt32BE(8);
}
