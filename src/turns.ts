// Group a thread's checkpoints into turns for display. Pure and shared by the
// app and the CLI.

export interface TurnCheckpoint {
  id: string;
  kind: "before-turn" | "after-turn" | "manual" | "pre-restore";
  attempt: "start-turn" | "join-turn" | null;
  messageExcerpt: string | null;
  createdAt: number;
}

export interface TurnGroup<T extends TurnCheckpoint> {
  key: string;
  kind: "turn" | "manual" | "restore";
  /** 1-based number among `turn` groups; null for other kinds. */
  turn: number | null;
  before: T | null;
  after: T | null;
  /** Mid-turn checkpoints: steers, manual checkpoints taken while running. */
  extras: T[];
  excerpt: string | null;
  startedAt: number;
}

export function groupTurns<T extends TurnCheckpoint>(checkpoints: readonly T[]): Array<TurnGroup<T>> {
  const groups: Array<TurnGroup<T>> = [];
  let open: TurnGroup<T> | null = null;
  let turn = 0;
  const startTurn = (checkpoint: T | null, excerpt: string | null, startedAt: number): TurnGroup<T> => {
    turn += 1;
    const group: TurnGroup<T> = {
      key: checkpoint?.id ?? `turn-${turn}`,
      kind: "turn",
      turn,
      before: checkpoint,
      after: null,
      extras: [],
      excerpt,
      startedAt,
    };
    groups.push(group);
    return group;
  };

  for (const checkpoint of checkpoints) {
    switch (checkpoint.kind) {
      case "before-turn":
        if (checkpoint.attempt === "join-turn" && open !== null) {
          open.extras.push(checkpoint);
        } else {
          open = startTurn(checkpoint, checkpoint.messageExcerpt, checkpoint.createdAt);
        }
        break;
      case "after-turn":
        if (open !== null && open.after === null) {
          open.after = checkpoint;
        } else {
          const group = startTurn(null, null, checkpoint.createdAt);
          group.after = checkpoint;
          group.key = checkpoint.id;
        }
        open = null;
        break;
      case "manual":
        if (open !== null) {
          open.extras.push(checkpoint);
        } else {
          groups.push({
            key: checkpoint.id,
            kind: "manual",
            turn: null,
            before: null,
            after: checkpoint,
            extras: [],
            excerpt: null,
            startedAt: checkpoint.createdAt,
          });
        }
        break;
      case "pre-restore":
        groups.push({
          key: checkpoint.id,
          kind: "restore",
          turn: null,
          before: null,
          after: checkpoint,
          extras: [],
          excerpt: null,
          startedAt: checkpoint.createdAt,
        });
        break;
    }
  }
  return groups;
}
