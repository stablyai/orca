import type { AgentStatusState } from './agent-status-types'
import type { AgentJournalTurnOutcome } from './agent-turn-outcome'

/** The main agent's OWN state, kept apart from the row's combined `state`. The row's
 *  `state` answers "what should the user see" and folds live child work in, so a settled main agent
 *  whose subagent still runs reads `working`; this answers "what is the main agent itself doing".
 *  Persisted on disk and carried on every wire, so its shape is permanent. */
export type AgentMainAgentStatus = {
  state: AgentStatusState
  /** The recorded verdict on the main agent's most recent finished turn: reported by the
   *  provider, or `cancellation` inferred from the user's own interrupt keystroke. Present only
   *  while `state` is `done`; a new turn clears it. ABSENT MEANS UNKNOWN — a plain Stop never
   *  infers `success`, because an older provider that omits its interrupt flag would turn
   *  a cancel into a false success. */
  outcome?: AgentJournalTurnOutcome
  /** When the main agent's own `state` first appeared (ms). The row's `stateStartedAt` dates the
   *  combined state instead, so the two differ while child work holds the row open. */
  stateStartedAt: number
}

export function mainAgentStatusEqual(
  a: AgentMainAgentStatus | undefined,
  b: AgentMainAgentStatus | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  return a.state === b.state && a.outcome === b.outcome && a.stateStartedAt === b.stateStartedAt
}
