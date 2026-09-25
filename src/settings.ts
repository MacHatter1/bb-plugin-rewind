// Settings descriptors and the one normalizer every consumer reads through.
// Stored values are validated by the schemas on save, but values can also come
// from older installs or hand-edited config, so `normalizeSettings` clamps
// again instead of trusting them.
import { z } from "zod";
import { DEFAULT_GATE_HOLD_MS, GATE_WAIT_CAP_MS, MAX_GATE_HOLD_MS } from "./constants";

// Names may contain spaces, so only commas and line breaks separate entries.
const EXCLUDED_SEPARATOR = /[,\r\n]+/u;
const MAX_EXCLUDED_ENTRIES = 200;
const MAX_EXCLUDED_ENTRY_CHARS = 200;

export const settingsDescriptors = {
  enabled: {
    type: "boolean",
    label: "Take checkpoints automatically",
    description:
      "Snapshot each thread's workspace before and after every turn. Manual checkpoints, restores, and forks keep working when this is off.",
    default: true,
  },
  gateHoldMs: {
    type: "number",
    label: "Hold a message for its checkpoint (ms)",
    description: `How long a message is held while its before-turn checkpoint is saved. A slower checkpoint queues the message ("Rewind: saving a checkpoint…") until it is saved, ${GATE_WAIT_CAP_MS / 1000} seconds at most. 0 to ${MAX_GATE_HOLD_MS}.`,
    experimental_schema: z.number().int().min(0).max(MAX_GATE_HOLD_MS),
    default: DEFAULT_GATE_HOLD_MS,
  },
  maxFileSizeMB: {
    type: "number",
    label: "Largest file to capture (MB)",
    description:
      "Files larger than this are left out of checkpoints, listed as skipped, and never touched by a restore.",
    experimental_schema: z.number().min(0.1).max(1024),
    default: 10,
  },
  maxCheckpointsPerThread: {
    type: "number",
    label: "Checkpoints kept per thread",
    description: "The daily cleanup keeps this many of each thread's newest checkpoints.",
    experimental_schema: z.number().int().min(10).max(5_000),
    default: 200,
  },
  retentionDays: {
    type: "number",
    label: "Days to keep checkpoints of archived threads",
    experimental_schema: z.number().int().min(1).max(365),
    default: 14,
  },
  excludedProjects: {
    type: "string",
    label: "Projects without automatic checkpoints",
    description:
      "Project ids (proj_…) or exact project names, separated by commas or new lines.",
    experimental_multiline: true,
    experimental_schema: z
      .string()
      .max(MAX_EXCLUDED_ENTRIES * (MAX_EXCLUDED_ENTRY_CHARS + 1))
      .refine(
        (value) => splitExcludedProjects(value).every((entry) => entry.length <= MAX_EXCLUDED_ENTRY_CHARS),
        `Each entry must be at most ${MAX_EXCLUDED_ENTRY_CHARS} characters`,
      )
      .refine(
        (value) => splitExcludedProjects(value).length <= MAX_EXCLUDED_ENTRIES,
        `At most ${MAX_EXCLUDED_ENTRIES} projects`,
      ),
    default: "",
  },
} as const;

export interface RewindSettings {
  enabled: boolean;
  gateHoldMs: number;
  maxFileBytes: number;
  maxCheckpointsPerThread: number;
  retentionDays: number;
  /** Lower-cased ids and names. */
  excludedProjects: ReadonlySet<string>;
}

export const DEFAULT_SETTINGS: RewindSettings = normalizeSettings({});

function splitExcludedProjects(value: string): string[] {
  return value
    .split(EXCLUDED_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamp raw stored values into the ranges the plugin relies on. */
export function normalizeSettings(raw: Record<string, unknown>): RewindSettings {
  const excluded = typeof raw.excludedProjects === "string" ? raw.excludedProjects : "";
  const entries = splitExcludedProjects(excluded)
    .slice(0, MAX_EXCLUDED_ENTRIES)
    .map((entry) => entry.slice(0, MAX_EXCLUDED_ENTRY_CHARS).toLowerCase());
  const maxFileSizeMB = clamp(finiteNumber(raw.maxFileSizeMB, 10), 0.1, 1024);
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    gateHoldMs: Math.floor(clamp(finiteNumber(raw.gateHoldMs, DEFAULT_GATE_HOLD_MS), 0, MAX_GATE_HOLD_MS)),
    maxFileBytes: Math.floor(maxFileSizeMB * 1024 * 1024),
    maxCheckpointsPerThread: Math.floor(clamp(finiteNumber(raw.maxCheckpointsPerThread, 200), 10, 5_000)),
    retentionDays: Math.floor(clamp(finiteNumber(raw.retentionDays, 14), 1, 365)),
    excludedProjects: new Set(entries),
  };
}

export function isProjectExcluded(
  settings: RewindSettings,
  project: { id: string; name?: string | null } | null,
): boolean {
  if (project === null || settings.excludedProjects.size === 0) return false;
  if (settings.excludedProjects.has(project.id.toLowerCase())) return true;
  const name = project.name?.trim().toLowerCase();
  return name !== undefined && name.length > 0 && settings.excludedProjects.has(name);
}
