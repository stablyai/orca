import { isAgentTurnOutcome, type AgentTurnOutcome } from './agent-turn-outcome'
import type { AgentStatusState } from './agent-status-types'
import type { AgentMainAgentStatus } from './main-agent-status'

export type AgentMainAgentVerdictSource = {
  state: AgentStatusState
  interrupted?: boolean
  mainAgent?: { state: AgentStatusState; outcome?: AgentTurnOutcome }
}

/** Copy both verdict forms through agentVerdictFields so history, sleep and worktree ps records cannot lose one. */
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

/** Read finished lead outcome even while children run; legacy interrupted means cancellation and requires combined done. Live leads, absent verdicts and unknown newer-host arms return null. */
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

/** Faults outrank combined state as news; cancellation/supersession/unconfirmed marks wait for combined done so live children remain visible. */
export function agentVerdictDisplayMark(
  row: AgentMainAgentVerdictSource
): 'failed' | 'interrupted' | 'unconfirmed' | null {
  switch (agentMainAgentVerdict(row)) {
    case 'failure':
    case 'interruption':
      return 'failed'
    case 'cancellation':
    case 'superseded':
      return row.state === 'done' ? 'interrupted' : null
    case 'unconfirmed':
      return row.state === 'done' ? 'unconfirmed' : null
    case 'success':
    case null:
      return null
  }
}

/** Clean-finish gates treat stopped, replaced, failed, cut-off and unconfirmed turns alike. */
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

/** Attention demotes intentional Stop/replacement only; unsolicited faults and unconfirmed ends remain news like completion. */
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
