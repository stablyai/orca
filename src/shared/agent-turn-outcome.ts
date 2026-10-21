import type { AgentJournalTurnLifecycleState } from './agent-session-journal-types'

/** The verdict on what became of a turn, kept separate from any lifecycle state
 *  so those stay a report on what the HOST observed. `cancellation` is a stop
 *  somebody asked for, `failure` is the provider's own error, and the two are
 *  never interchangeable: only `failure` is a fault. `superseded` is a turn a newer
 *  request replaced before it ended, which the host records at the replacement; it
 *  names no sender. The journal's turn record stores only these recorded verdicts
 *  (the provider's, a stop, or the host's supersede); `interruption` and `unconfirmed`
 *  are derived from lifecycle state on read and never stored. Absent always means
 *  UNKNOWN, never success. Older builds read an arm they do not know as absent. */
export const AGENT_JOURNAL_TURN_OUTCOMES = [
  'success',
  'failure',
  'cancellation',
  'superseded'
] as const
export type AgentJournalTurnOutcome = (typeof AGENT_JOURNAL_TURN_OUTCOMES)[number]

/** The verdict an agent-status row's `mainAgent.outcome` reports: the provider's, a `cancellation`
 *  Orca inferred from the user's own interrupt keystroke, or what the host observed of a turn's end
 *  when the provider gave no verdict. `interruption` is a death mid-turn the host proved and nobody
 *  asked for; `unconfirmed` is an end the host cannot prove, and is never success. Both are derived
 *  from the turn's lifecycle state, so the journal never stores them. */
export const AGENT_TURN_OUTCOMES = [
  ...AGENT_JOURNAL_TURN_OUTCOMES,
  'interruption',
  'unconfirmed'
] as const
export type AgentTurnOutcome = (typeof AGENT_TURN_OUTCOMES)[number]

export function isAgentTurnOutcome(value: unknown): value is AgentTurnOutcome {
  return AGENT_TURN_OUTCOMES.some((known) => known === value)
}

/** The verdict a settled turn reports: the provider's own, else what the host observed of its end.
 *  Derived, never journaled: the lifecycle state is the durable fact. A null state is a send that
 *  never became a turn. */
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
