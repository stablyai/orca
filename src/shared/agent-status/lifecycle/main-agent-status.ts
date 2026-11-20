import type { AgentStatusState } from '../contracts/agent-status-types'
import type { AgentTurnOutcome } from './agent-turn-outcome'

/** Main agent state, distinct from the row’s child-folded state (a settled main agent with live children still reads working).
 * Persisted and carried on every wire; preserve the shape. */
export type AgentMainAgentStatus = {
  state: AgentStatusState
  /** Latest finished-turn verdict, only while done; a new turn clears it. Provider-reported, inferred cancellation, or host-observed end.
   * Absent means unknown: never infer success from plain Stop, because older providers omit interrupt flags. */
  outcome?: AgentTurnOutcome
  /** A user’s Stop is ending the working turn. Structured hosts publish it; readers display it without storing it. */
  stopping?: true
  /** The agent started this turn itself to handle a finished background task; its end is no news to the person. */
  taskWakeup?: true
  /** When the main agent’s state began (ms); the row’s stateStartedAt dates its combined state and can differ while children run. */
  stateStartedAt: number
}

/** The main agent's own state where the row carries one; older rows only have the combined state. */
export function mainAgentState(row: {
  state: AgentStatusState
  mainAgent?: AgentMainAgentStatus
}): AgentStatusState {
  return row.mainAgent?.state ?? row.state
}

/** When the main agent's current done state began, naming the turn it finished; undefined unless done. */
export function mainAgentDoneAt(row: {
  state: AgentStatusState
  stateStartedAt: number
  mainAgent?: AgentMainAgentStatus
}): number | undefined {
  const lead = row.mainAgent ?? row
  return lead.state === 'done' ? lead.stateStartedAt : undefined
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
  return (
    a.state === b.state &&
    a.outcome === b.outcome &&
    a.stopping === b.stopping &&
    a.taskWakeup === b.taskWakeup &&
    a.stateStartedAt === b.stateStartedAt
  )
}

/** The agent started this turn for its own finished background task and it has not failed: neither its start nor its end is news. */
export function isQuietTaskWakeup(row: { mainAgent?: AgentMainAgentStatus }): boolean {
  return row.mainAgent?.taskWakeup === true && row.mainAgent.outcome !== 'failure'
}
