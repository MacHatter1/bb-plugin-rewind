// Keep timing-sensitive experiments out of the normal regression suite.
import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/performance/checkpoint.bench.ts"],
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});
