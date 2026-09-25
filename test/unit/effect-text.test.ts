import { describe, expect, it } from "vitest";
import { turnEffectsSentence, undoneEffectsSentence } from "../../src/effect-text";

describe("wording for effects Rewind cannot undo", () => {
  it("names a turn's commands once each", () => {
    expect(turnEffectsSentence([])).toBeNull();
    expect(turnEffectsSentence([{ label: "git push" }])).toBe("This turn ran `git push`; Rewind can't undo that.");
    expect(turnEffectsSentence([{ label: "git push" }, { label: "npm publish" }, { label: "git push" }, { label: "docker run" }])).toBe(
      "This turn ran `git push`, `npm publish` and `docker run`; Rewind can't undo those.",
    );
  });

  it("groups the undone turns' commands by turn, the latest last", () => {
    expect(undoneEffectsSentence([])).toBeNull();
    expect(undoneEffectsSentence([{ label: "git push", turn: 4 }])).toBe("Turn 4 ran `git push`. Rewind can't undo that.");
    expect(
      undoneEffectsSentence([
        { label: "git push", turn: 4 },
        { label: "npm publish", turn: 5 },
        { label: "kubectl apply", turn: 5 },
        { label: "curl POST", turn: null },
      ]),
    ).toBe("Turn 4 ran `git push`; turn 5 ran `npm publish` and `kubectl apply`; the latest turn ran `curl POST`. Rewind can't undo those.");
  });
});
