// Wording for commands whose effects outside the workspace Rewind cannot
// undo. Shared by the CLI and the app, so both say the same thing.

interface EffectLike {
  label: string;
  turn?: number | null;
}

function joinLabels(labels: readonly string[]): string {
  const quoted = labels.map((label) => `\`${label}\``);
  return quoted.length <= 1 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

/** "This turn ran `git push`; Rewind can't undo that." */
export function turnEffectsSentence(effects: readonly EffectLike[]): string | null {
  const labels = [...new Set(effects.map((effect) => effect.label))];
  if (labels.length === 0) return null;
  return `This turn ran ${joinLabels(labels)}; Rewind can't undo ${labels.length === 1 ? "that" : "those"}.`;
}

/** "Turn 4 ran `git push`; turn 5 ran `npm publish`. Rewind can't undo those." */
export function undoneEffectsSentence(effects: readonly EffectLike[]): string | null {
  const byTurn = new Map<string, string[]>();
  for (const effect of effects) {
    const key = effect.turn === null || effect.turn === undefined ? "latest" : String(effect.turn);
    const labels = byTurn.get(key) ?? [];
    if (!labels.includes(effect.label)) labels.push(effect.label);
    byTurn.set(key, labels);
  }
  if (byTurn.size === 0) return null;
  const parts = [...byTurn].map(([turn, labels], index) => {
    const who = turn === "latest" ? "the latest turn" : `turn ${turn}`;
    return `${index === 0 ? who.charAt(0).toUpperCase() + who.slice(1) : who} ran ${joinLabels(labels)}`;
  });
  const total = [...byTurn.values()].reduce((sum, labels) => sum + labels.length, 0);
  return `${parts.join("; ")}. Rewind can't undo ${total === 1 ? "that" : "those"}.`;
}
