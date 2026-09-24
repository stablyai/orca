import type { AgentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentMainAgentStatus, AgentStatusState, AgentWorkingMode } from './agent-status-types'

export type AgentLeadStatusFoldInput = {
  /** The lead's own turn state. Anything but `done` wins outright. */
  leadState: AgentStatusState
  /** A lead turn that ended by interrupt keeps a watch loop from reading as monitoring;
   *  live agent work still counts, because it outlives the interrupt. */
  interrupted: boolean
  childWorkLiveness: AgentChildWorkLiveness
}

export type AgentLeadStatusResolution = {
  stateName: AgentStatusState
  workingMode?: AgentWorkingMode
}

/**
 * One fold for every lane that publishes a lead agent's status: a settled lead
 * with live agent work is still working, and a settled lead with only watch
 * loops is monitoring. The hook lane and the structured session lane derive
 * the liveness from different evidence, but the policy must not differ.
 */
export function foldAgentLeadStatus(input: AgentLeadStatusFoldInput): AgentLeadStatusResolution {
  if (input.leadState !== 'done') {
    return { stateName: input.leadState }
  }
  if (input.childWorkLiveness === 'working') {
    return { stateName: 'working' }
  }
  if (input.childWorkLiveness === 'monitoring' && !input.interrupted) {
    return { stateName: 'working', workingMode: 'monitoring' }
  }
  return { stateName: 'done' }
}

/** The main agent settled and live child work is the only thing holding the row open. Derived,
 *  never stored: a stored copy could disagree with the two facts it is made of. */
export function isAgentStatusHeldOpenByChildWork(row: {
  state: AgentStatusState
  mainAgent?: Pick<AgentMainAgentStatus, 'state'>
}): boolean {
  return row.mainAgent?.state === 'done' && row.state !== 'done'
}

/** The main agent's clock follows the same continuity rule as the row's: an unchanged main agent state
 *  keeps the instant it first appeared, a changed one starts at `now`. A caller that knows
 *  the real instant (a restored stash, a journal record) passes it and wins. */
export function continueMainAgentStatus(
  previous: Pick<AgentMainAgentStatus, 'state' | 'stateStartedAt'> | undefined,
  next: {
    state: AgentStatusState
    outcome?: AgentMainAgentStatus['outcome']
    stateStartedAt?: number
  },
  now: number
): AgentMainAgentStatus {
  const stateStartedAt =
    next.stateStartedAt ??
    (previous && previous.state === next.state ? previous.stateStartedAt : now)
  return {
    state: next.state,
    ...(next.state === 'done' && next.outcome ? { outcome: next.outcome } : {}),
    stateStartedAt
  }
}
