/** The verdict on what became of a turn, kept separate from any lifecycle state
 *  so those stay a report on what the HOST observed. `cancellation` is a stop
 *  somebody asked for, `failure` is the provider's own error, and the two are
 *  never interchangeable: only `failure` is a fault. Shared by the journal's turn
 *  record, which holds only the provider's verdict and never infers one, and the
 *  agent-status row's `mainAgent.outcome`, which also records a `cancellation`
 *  Orca inferred from the user's own interrupt keystroke. Absent always means
 *  UNKNOWN, never success. */
export const AGENT_JOURNAL_TURN_OUTCOMES = ['success', 'failure', 'cancellation'] as const
export type AgentJournalTurnOutcome = (typeof AGENT_JOURNAL_TURN_OUTCOMES)[number]

export function isAgentJournalTurnOutcome(value: unknown): value is AgentJournalTurnOutcome {
  return AGENT_JOURNAL_TURN_OUTCOMES.some((known) => known === value)
}
