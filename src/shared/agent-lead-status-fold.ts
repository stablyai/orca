import type { AgentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentStatusState, AgentWorkingMode } from './agent-status-types'

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
