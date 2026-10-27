import type { AgentJournalTurnLifecycleState } from './agent-session-journal-types'

/** Keep recorded provider/Stop/supersede verdicts separate from host lifecycle state. cancellation is requested, failure is a provider fault, superseded names no sender. Derive interruption/unconfirmed on read, never journal them. Absent/newer arms mean unknown, never success. */
export const AGENT_JOURNAL_TURN_OUTCOMES = [
  'success',
  'failure',
  'cancellation',
  'superseded'
] as const
export type AgentJournalTurnOutcome = (typeof AGENT_JOURNAL_TURN_OUTCOMES)[number]

/** Status outcomes may include inferred user cancellation or derived interruption (proven unsolicited death)/unconfirmed (unproven end, never success). Derive these from lifecycle, never journal them. */
export const AGENT_TURN_OUTCOMES = [
  ...AGENT_JOURNAL_TURN_OUTCOMES,
  'interruption',
  'unconfirmed'
] as const
export type AgentTurnOutcome = (typeof AGENT_TURN_OUTCOMES)[number]

export function isAgentTurnOutcome(value: unknown): value is AgentTurnOutcome {
  return AGENT_TURN_OUTCOMES.some((known) => known === value)
}

/** Derive settled verdict from provider outcome or host lifecycle; never journal derived verdicts. null state means a send that never became a turn. */
export function agentTurnVerdict(turn: {
  state: AgentJournalTurnLifecycleState | null
  outcome: AgentJournalTurnOutcome | null
}): AgentTurnOutcome | null {
  if (turn.outcome) {
    return turn.outcome
  }
  switch (turn.state) {
    case 'interrupted':
      return 'interruption'
    case 'unverifiable':
      return 'unconfirmed'
    // A `completed` end without a verdict is an older provider's, or an older host's: unknown.
    case 'completed':
    case 'running':
    case null:
      return null
  }
}
