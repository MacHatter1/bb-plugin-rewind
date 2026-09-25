import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // Integration tests spawn real git processes; keep them off the default 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
