import type { AgentStatusState } from './agent-status-types'

/** A row carrying the turn fact and the pane state it was observed on. */
export type AgentInterruptOutcomeSource = {
  state: AgentStatusState
  interrupted?: boolean
}

/**
 * True when the pane finished AND the user is why. Two different questions used to share one
 * field: "the user stopped this turn" (`interrupted`) and "this pane is finished" (`state`).
 * A stopped turn does not stop the background shells and crons the pane may still report, so the
 * facts are stored apart and this is the single place their conjunction is spelled.
 *
 * Ask this for a terminal outcome — a badge, a completion clock, a hibernation or retention gate.
 * Read `interrupted` alone only to say what happened to the turn itself.
 */
export function isInterruptedAgentCompletion(row: AgentInterruptOutcomeSource): boolean {
  return row.state === 'done' && row.interrupted === true
}
