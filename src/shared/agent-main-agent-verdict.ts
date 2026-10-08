import { isAgentTurnOutcome, type AgentTurnOutcome } from './agent-turn-outcome'
import type { AgentStatusState } from './agent-status-types'
import type { AgentMainAgentStatus } from './main-agent-status'

export type AgentMainAgentVerdictSource = {
  state: AgentStatusState
  interrupted?: boolean
  mainAgent?: { state: AgentStatusState; outcome?: AgentTurnOutcome }
}

/** The fields that carry the verdict. History entries, sleep records and `worktree ps` rows copy
 *  them through {@link agentVerdictFields}, so no copy keeps one form and drops the other. */
export type AgentVerdictFields = {
  interrupted?: true
  mainAgent?: AgentMainAgentStatus
}

/** The verdict-bearing fields to copy from a row onto another record. */
export function agentVerdictFields(row: {
  interrupted?: boolean
  mainAgent?: AgentMainAgentStatus
}): AgentVerdictFields {
  return {
    ...(row.interrupted === true ? { interrupted: true } : {}),
    ...(row.mainAgent ? { mainAgent: row.mainAgent } : {})
  }
}

/**
 * The recorded verdict on the main agent's latest finished turn. One fact at two fidelities:
 * `mainAgent.outcome`, and the legacy `interrupted` flag, which only ever meant a cancellation.
 * Read from the main agent's own state, not the combined row's: a main agent that failed while its
 * subagents still work has a verdict. Null while the main agent is not done, and when no verdict
 * was recorded. Only the legacy flag needs the combined `done`, because a row without `mainAgent`
 * has nothing else that says the main agent itself finished. An arm from a newer host reads as no
 * verdict: some mirrored rows reach here unparsed.
 */
export function agentMainAgentVerdict(row: AgentMainAgentVerdictSource): AgentTurnOutcome | null {
  if (row.mainAgent && row.mainAgent.state !== 'done') {
    return null
  }
  const outcome = row.mainAgent?.outcome
  if (outcome !== undefined) {
    return isAgentTurnOutcome(outcome) ? outcome : null
  }
  return row.state === 'done' && row.interrupted === true ? 'cancellation' : null
}

/**
 * What the verdict marks on the agent's own display. A failure reads failed and outranks every
 * combined state: it is news the user must see even while subagents still run. A turn that ended
 * early reads interrupted, whoever ended it (a user's Stop, a newer request, or a crash, quit or
 * restart), and an unproven end unconfirmed, only on a row that is itself done, so live child work
 * still reads working.
 */
export function agentVerdictDisplayMark(
  row: AgentMainAgentVerdictSource
): 'failed' | 'interrupted' | 'unconfirmed' | null {
  switch (agentMainAgentVerdict(row)) {
    case 'failure':
      return 'failed'
    case 'cancellation':
    case 'superseded':
    case 'interruption':
      return row.state === 'done' ? 'interrupted' : null
    case 'unconfirmed':
      return row.state === 'done' ? 'unconfirmed' : null
    case 'success':
    case null:
      return null
  }
}

/** The turn ended without finishing its work: stopped, replaced, failed, cut off, or unproven.
 *  Clean-finish policy (hibernation, pane ownership, the value moment) treats them all alike. */
export function agentTurnEndedUncleanly(row: AgentMainAgentVerdictSource): boolean {
  const verdict = agentMainAgentVerdict(row)
  switch (verdict) {
    case 'cancellation':
    case 'superseded':
    case 'failure':
    case 'interruption':
    case 'unconfirmed':
      return true
    case 'success':
    case null:
      return false
  }
}

/** The turn was ended on purpose, not by a fault: the user's Stop, or a newer request that
 *  replaced it. Attention (completion time, Smart Sort, sticky retention) demotes only this: a
 *  failure, or a turn cut off or ended in a way nobody asked for, is news the user has not seen,
 *  so it ranks like a completion. */
export function agentTurnEndedOnPurpose(row: AgentMainAgentVerdictSource): boolean {
  const verdict = agentMainAgentVerdict(row)
  switch (verdict) {
    case 'cancellation':
    case 'superseded':
      return true
    case 'success':
    case 'failure':
    case 'interruption':
    case 'unconfirmed':
    case null:
      return false
  }
}
