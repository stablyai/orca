import type { AgentTabLaunchOutcome } from './launch-agent-in-new-tab-host-agents'

export function nonRefusedAgentLaunch(outcome: AgentTabLaunchOutcome | undefined) {
  if (outcome && 'refused' in outcome) {
    throw new Error('Expected the launch to open a surface')
  }
  return outcome
}
