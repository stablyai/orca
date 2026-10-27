// Keep start-failed/process-exited outcomes in memory beside start tokens; relaunch makes unbound panes restorable again.

export type PaneOutcome = 'failed' | 'exited'

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
