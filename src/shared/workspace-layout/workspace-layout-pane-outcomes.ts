// A pane's last outcome: why a pane with no live terminal is not simply restorable. Held in memory
// beside the start tokens, never saved, so a relaunch makes every such pane restorable again.

/** `failed`: its start failed. `exited`: its process exited and the pane was kept to show why. */
export type PaneOutcome = 'failed' | 'exited'

/** Leaf id → last outcome. */
export type PaneOutcomes = Readonly<Record<string, PaneOutcome>>

/** What one apply changed; null clears the leaf's outcome. */
export type PaneOutcomeChanges = Readonly<Record<string, PaneOutcome | null>>

export function applyPaneOutcomeChanges(
  outcomes: PaneOutcomes,
  changes: PaneOutcomeChanges | undefined
): PaneOutcomes {
  if (!changes || Object.keys(changes).length === 0) {
    return outcomes
  }
  const next: Record<string, PaneOutcome> = { ...outcomes }
  for (const [leafId, outcome] of Object.entries(changes)) {
    if (outcome) {
      next[leafId] = outcome
    } else {
      delete next[leafId]
    }
  }
  return next
}
