import type { AgentJournalTurnOutcome } from './agent-turn-outcome'
import type { AgentStatusState } from './agent-status-types'

export type AgentMainAgentVerdictSource = {
  state: AgentStatusState
  interrupted?: boolean
  mainAgent?: { outcome?: AgentJournalTurnOutcome }
  /** History entries and `worktree ps` rows carry the verdict at the top level. */
  outcome?: AgentJournalTurnOutcome
}

/**
 * The recorded verdict on the main agent's latest finished turn, for a row the user sees as done.
 * One fact at two fidelities: `mainAgent.outcome`, and the legacy `interrupted` flag, which only
 * ever meant a cancellation. Null while the row is not done — a lead that failed while its child
 * still works reads working — and when no verdict was recorded.
 */
export function agentMainAgentVerdict(
  row: AgentMainAgentVerdictSource
): AgentJournalTurnOutcome | null {
  if (row.state !== 'done') {
    return null
  }
  return row.mainAgent?.outcome ?? row.outcome ?? (row.interrupted === true ? 'cancellation' : null)
}

/** The turn ended without finishing its work: stopped, or failed. Clean-finish policy
 *  (hibernation, pane ownership, the value moment) treats both alike. */
export function agentTurnEndedUncleanly(row: AgentMainAgentVerdictSource): boolean {
  const verdict = agentMainAgentVerdict(row)
  return verdict === 'cancellation' || verdict === 'failure'
}

/** The user stopped the turn. Attention (completion time, Smart Sort, sticky retention) demotes
 *  only this: a failure is news the user has not seen, so it ranks like a completion. */
export function agentTurnStoppedByUser(row: AgentMainAgentVerdictSource): boolean {
  return agentMainAgentVerdict(row) === 'cancellation'
}
