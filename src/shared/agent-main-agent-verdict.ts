import type { AgentJournalTurnOutcome } from './agent-turn-outcome'
import type { AgentStatusState } from './agent-status-types'

export type AgentMainAgentVerdictSource = {
  state: AgentStatusState
  interrupted?: boolean
  mainAgent?: { state: AgentStatusState; outcome?: AgentJournalTurnOutcome }
  /** History entries, sleep records and `worktree ps` rows carry the main agent's verdict at the
   *  top level; every writer records it only for a main agent that is itself done. */
  outcome?: AgentJournalTurnOutcome
}

/**
 * The recorded verdict on the main agent's latest finished turn. One fact at two fidelities:
 * `mainAgent.outcome` (or its top-level copy), and the legacy `interrupted` flag, which only ever
 * meant a cancellation. Read from the main agent's own state, not the combined row's: a main agent
 * that failed while its subagents still work has a verdict. Null while the main agent is not done,
 * and when no verdict was recorded. Only the legacy flag needs the combined `done`, because a row
 * without `mainAgent` has nothing else that says the main agent itself finished.
 */
export function agentMainAgentVerdict(
  row: AgentMainAgentVerdictSource
): AgentJournalTurnOutcome | null {
  if (row.mainAgent && row.mainAgent.state !== 'done') {
    return null
  }
  return (
    row.mainAgent?.outcome ??
    row.outcome ??
    (row.state === 'done' && row.interrupted === true ? 'cancellation' : null)
  )
}

/**
 * What the verdict marks on the agent's own display. A failure outranks every combined state: it
 * is news the user must see even while subagents still run. A stop marks only a row that is itself
 * done, so a stopped main agent's live child work still reads working, as a clean finish does.
 */
export function agentVerdictDisplayMark(
  row: AgentMainAgentVerdictSource
): 'failed' | 'interrupted' | null {
  const verdict = agentMainAgentVerdict(row)
  if (verdict === 'failure') {
    return 'failed'
  }
  return verdict === 'cancellation' && row.state === 'done' ? 'interrupted' : null
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
