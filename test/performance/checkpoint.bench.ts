// Opt-in production-engine benchmark. Real host RPC schemas and Git;
// disposable workspaces, with timing only (no algorithm replacements).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, expect, it, vi } from "vitest";
import hostEntry from "../../host";
import { clearUserRepoCaches } from "../../src/host/user-repo";
import { newId } from "../../src/ids";
import { initRepo, removeTempDirs, tempDir } from "../helpers/fs";

const trace = vi.hoisted(() => ({
  stage: "setup",
  calls: [] as { stage: string; verb: string; ms: number }[],
}));

// Transparent timing wrapper: every call still executes the real Git runner.
vi.mock("../../src/host/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/host/git")>();
  const verbs = new Set([
    "init", "rev-parse", "config", "status", "ls-files", "update-index",
    "write-tree", "commit-tree", "update-ref", "cat-file", "diff-tree", "symbolic-ref",
  ]);
  return {
    ...actual,
    runGit: async (...parameters: Parameters<typeof actual.runGit>) => {
      const stage = trace.stage;
      const start = performance.now();
      try {
        return await actual.runGit(...parameters);
      } finally {
        trace.calls.push({
          stage,
          verb: parameters[0].find((arg) => verbs.has(arg)) ?? "other",
          ms: performance.now() - start,
        });
      }
    },
  };
});

const LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 100_000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

const sizes = (process.env.REWIND_BENCH_SIZES ?? "10,100,1000").split(",").map(Number);
if (sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 99_999)) {
  throw new Error("REWIND_BENCH_SIZES must be comma-separated integers from 1 to 99999");
}
const rounds = integerSetting("REWIND_BENCH_ROUNDS", 3, 1, 20);
const forcedCount = integerSetting("REWIND_BENCH_FORCED", 0, 0, 99_999);
const maxMs = process.env.REWIND_BENCH_MAX_MS === undefined ? Infinity : Number(process.env.REWIND_BENCH_MAX_MS);
if (!(maxMs > 0)) throw new Error("REWIND_BENCH_MAX_MS must be positive");
const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

afterEach(removeTempDirs);

function printGitTrace(): void {
  const summary: Record<string, Record<string, { calls: number; totalMs: number }>> = {};
  for (const call of trace.calls) {
    const stage = summary[call.stage] ??= {};
    const verb = stage[call.verb] ??= { calls: 0, totalMs: 0 };
    verb.calls += 1;
    verb.totalMs += call.ms;
  }
  for (const stage of Object.values(summary)) {
    for (const verb of Object.values(stage)) verb.totalMs = Math.round(verb.totalMs);
  }
  // HEAD's two commands run in parallel: summed command time is not wall time.
  console.log("GIT_TRACE", JSON.stringify(summary));
}

for (const count of sizes) {
  it(`measures ${count} small tracked files`, async () => {
    clearUserRepoCaches();
    const workspace = await tempDir("perf-ws");
    const actualForced = Math.min(count, forcedCount);
    await mkdir(path.join(workspace, "src", "forced"), { recursive: true });
    await mkdir(path.join(workspace, "src", "regular"), { recursive: true });
    const relativeAt = (index: number) => `src/${index < actualForced ? "forced" : "regular"}/file-${String(index).padStart(5, "0")}.txt`;
    for (let index = 0; index < count; index += 1) {
      await writeFile(path.join(workspace, relativeAt(index)), `file ${index}\n${"x".repeat(128)}\n`);
    }
    // Track files first, then ignore one directory: they must still be captured.
    await initRepo(workspace, {});
    if (actualForced > 0) await writeFile(path.join(workspace, ".gitignore"), "src/forced/\n");
    const expectedFiles = count + (actualForced > 0 ? 1 : 0);
    const harness = experimental_createHostEntryHarness(hostEntry, {
      experimental_paths: { dataDir: await tempDir("perf-data"), tempDir: await tempDir("perf-tmp") },
    });
    let previous: string | null = null;
    const measure = async (stage: string, force = false) => {
      trace.stage = stage;
      const start = performance.now();
      const result = await harness.experimental_call("snapshot", {
        workspace,
        checkpointId: newId("ck"),
        kind: "manual",
        subject: "perf",
        compareTo: previous,
        limits: LIMITS,
        force,
      });
      const ms = performance.now() - start;
      if (result.status !== "ok") throw new Error(JSON.stringify(result));
      expect(result.fileCount).toBe(expectedFiles);
      previous = result.commit;
      return { ms: Math.round(ms), files: result.stats.files, deduped: result.deduped };
    };
    try {
      trace.calls = [];
      const cold = await measure("cold");
      expect(cold.files).toBe(expectedFiles);
      const unchanged = [];
      const changed = [];
      const forced = [];
      for (let round = 0; round < rounds; round += 1) {
        const result = await measure(`unchanged-${round}`);
        expect(result).toMatchObject({ files: 0, deduped: true });
        unchanged.push(result);
      }
      for (let round = 0; round < rounds; round += 1) {
        await writeFile(path.join(workspace, relativeAt(0)), `edit ${round}\n`);
        const result = await measure(`changed-${round}`);
        expect(result).toMatchObject({ files: 1, deduped: false });
        changed.push(result);
      }
      for (let round = 0; round < rounds; round += 1) {
        const result = await measure(`forced-${round}`, true);
        expect(result).toMatchObject({ files: 0, deduped: true });
        forced.push(result);
      }
      const warm = median(unchanged.map((result) => result.ms));
      console.log("CHECKPOINT_BENCH", JSON.stringify({
        count, forcedTracked: actualForced, engine: "production", cold, unchanged, changed, forced, unchangedMedianMs: warm,
      }));
      if (process.env.REWIND_BENCH_TRACE === "1") printGitTrace();
      expect(warm, `diagnostic target: unchanged checkpoint under ${maxMs}ms`).toBeLessThanOrEqual(maxMs);
    } finally {
      await harness.experimental_dispose();
    }
  }, 180_000);
}
