// Ignore rules for the shadow repository.
//
// The shadow reads the workspace's own .gitignore files natively (they are in
// its work tree). Everything else the user's git would apply is copied into
// the shadow's info/exclude: the repository's info/exclude, the user's
// excludes file, and — when the workspace is a subdirectory of a repository —
// the .gitignore files above it. Those rules are written relative to another
// directory, so each pattern is re-based onto the workspace root first.

/** Split a gitignore pattern into segments, keeping escapes intact. */
function segments(pattern: string): string[] {
  return pattern.split("/");
}

function escapeRegExpChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\/-]/gu, "\\$&");
}

function globSegmentToRegExp(segment: string): RegExp {
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === "\\" && index + 1 < segment.length) {
      source += escapeRegExpChar(segment[index + 1]!);
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const close = segment.indexOf("]", index + 2);
      if (close === -1) {
        source += "\\[";
      } else {
        let body = segment.slice(index + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        source += `[${body.replace(/\\/gu, "\\\\")}]`;
        index = close;
      }
    } else {
      source += escapeRegExpChar(char);
    }
  }
  return new RegExp(`^${source}$`, "u");
}

function segmentMatches(pattern: string, name: string): boolean {
  if (!/[*?[\\]/u.test(pattern)) return pattern === name;
  try {
    return globSegmentToRegExp(pattern).test(name);
  } catch {
    return false;
  }
}

/**
 * Re-base one gitignore line from a base directory onto a workspace below it.
 * `prefix` is the workspace's path relative to the base (`""` when they are
 * the same directory, else `a/b` without slashes at the ends).
 *
 * Returns the translated line, or null when the pattern cannot match anything
 * inside the workspace. Where a pattern cannot be re-based exactly (a `**`
 * that could absorb part of the prefix) the result errs toward ignoring more,
 * which only means Rewind captures and touches less.
 */
export function rebaseIgnoreLine(line: string, prefix: string): string | null {
  // Trailing whitespace is ignored by git unless escaped; keep the line as is
  // otherwise so escapes survive.
  const trimmed = line.replace(/(?<!\\)\s+$/u, "");
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  if (prefix.length === 0) return trimmed;

  const negated = trimmed.startsWith("!");
  let body = negated ? trimmed.slice(1) : trimmed;
  const directoryOnly = body.endsWith("/") && !body.endsWith("\\/");
  if (directoryOnly) body = body.slice(0, -1);
  if (body.length === 0) return null;

  const anchored = body.includes("/");
  if (!anchored) {
    // No slash: matches at any depth below the base, so also below the workspace.
    return trimmed;
  }
  if (body.startsWith("/")) body = body.slice(1);
  if (body.startsWith("**/")) {
    // Leading **/ matches in every directory: applies unchanged at any depth.
    return `${negated ? "!" : ""}${body}${directoryOnly ? "/" : ""}`;
  }

  const patternSegments = segments(body);
  const prefixSegments = prefix.split("/");
  let consumed = 0;
  for (; consumed < prefixSegments.length; consumed += 1) {
    const patternSegment = patternSegments[consumed];
    if (patternSegment === undefined) {
      // The whole pattern matches the workspace itself or an ancestor. An
      // ignored workspace is not a useful rule to copy; capture it anyway.
      return null;
    }
    if (patternSegment === "**") {
      // `**` may absorb the rest of the prefix and more: keep the remainder
      // matching at any depth inside the workspace.
      const rest = patternSegments.slice(consumed).join("/");
      return `${negated ? "!" : ""}${rest}${directoryOnly ? "/" : ""}`;
    }
    if (!segmentMatches(patternSegment, prefixSegments[consumed]!)) return null;
  }
  const rest = patternSegments.slice(consumed);
  if (rest.length === 0) return null;
  return `${negated ? "!" : ""}/${rest.join("/")}${directoryOnly ? "/" : ""}`;
}

export interface IgnoreSource {
  /** Where the rules came from, for the generated file's comments. */
  label: string;
  content: string;
  /** Workspace path relative to the directory the rules are written for. */
  prefix: string;
}

export const MANAGED_HEADER = "# Managed by Rewind. Rewritten before every snapshot; do not edit.";

/** Compose the shadow's info/exclude from the user's rules and our own. */
export function composeExcludeFile(sources: readonly IgnoreSource[], extraAnchored: readonly string[]): string {
  const lines: string[] = [MANAGED_HEADER];
  for (const source of sources) {
    const translated: string[] = [];
    for (const line of source.content.split(/\r?\n/u)) {
      const rebased = rebaseIgnoreLine(line, source.prefix);
      if (rebased !== null) translated.push(rebased);
    }
    if (translated.length === 0) continue;
    lines.push(`# From ${source.label.replace(/[\r\n]/gu, " ")}`);
    lines.push(...translated);
  }
  if (extraAnchored.length > 0) {
    lines.push("# Rewind's own storage inside this workspace");
    lines.push(...extraAnchored);
  }
  return `${lines.join("\n")}\n`;
}

/** An exact, anchored gitignore line for one relative path. */
export function anchoredPattern(relativePath: string, directory: boolean): string | null {
  if (relativePath.length === 0 || /[\r\n]/u.test(relativePath)) return null;
  const escaped = relativePath.replace(/[\\*?[\]!#]/gu, "\\$&").replace(/ $/u, "\\ ");
  return `/${escaped}${directory ? "/" : ""}`;
}
