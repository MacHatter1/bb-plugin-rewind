import { describe, expect, it } from "vitest";
import { GATE_HARD_LIMIT_MS, MAX_GATE_HOLD_MS } from "../../src/constants";
import { DEFAULT_SETTINGS, isProjectExcluded, normalizeSettings, settingsDescriptors } from "../../src/settings";

describe("settings", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      enabled: true,
      gateHoldMs: 200,
      maxFileBytes: 10 * 1024 * 1024,
      maxCheckpointsPerThread: 200,
      retentionDays: 14,
    });
    expect(DEFAULT_SETTINGS.excludedProjects.size).toBe(0);
  });

  it("clamps out-of-range and wrong-typed stored values", () => {
    const settings = normalizeSettings({
      enabled: "yes",
      gateHoldMs: 60_000,
      maxFileSizeMB: -3,
      maxCheckpointsPerThread: 1.7,
      retentionDays: Number.NaN,
    });
    expect(settings.enabled).toBe(true);
    expect(settings.gateHoldMs).toBe(MAX_GATE_HOLD_MS);
    expect(settings.maxFileBytes).toBe(Math.floor(0.1 * 1024 * 1024));
    expect(settings.maxCheckpointsPerThread).toBe(10);
    expect(settings.retentionDays).toBe(14);
  });

  it("keeps the hold short, well inside the hook's 10 second decision box", () => {
    expect(GATE_HARD_LIMIT_MS).toBeLessThan(10_000);
    const schema = settingsDescriptors.gateHoldMs.experimental_schema;
    expect(schema.safeParse(5_000).success).toBe(false);
    expect(schema.safeParse(0).success).toBe(true);
    expect(schema.safeParse(200).success).toBe(true);
    expect(schema.safeParse(1.5).success).toBe(false);
  });

  it("matches excluded projects by id or by name, case-insensitively, one entry per line or comma", () => {
    const settings = normalizeSettings({ excludedProjects: "proj_abc123\nMy Big Monorepo, other" });
    expect(isProjectExcluded(settings, { id: "proj_ABC123" })).toBe(true);
    expect(isProjectExcluded(settings, { id: "proj_x", name: "my big monorepo" })).toBe(true);
    expect(isProjectExcluded(settings, { id: "proj_x", name: "My Big" })).toBe(false);
    expect(isProjectExcluded(settings, null)).toBe(false);
  });

  it("validates the excluded projects list", () => {
    const schema = settingsDescriptors.excludedProjects.experimental_schema;
    expect(schema.safeParse("proj_a, proj_b").success).toBe(true);
    expect(schema.safeParse("x".repeat(201)).success).toBe(false);
    expect(schema.safeParse(Array.from({ length: 201 }, (_, index) => `p${index}`).join(",")).success).toBe(false);
  });
});
