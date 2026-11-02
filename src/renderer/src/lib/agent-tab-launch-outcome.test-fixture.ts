import type { AgentTabLaunchOutcome } from './launch-agent-in-new-tab-host-agents'

/** The tab a test's launch opened; a refusal opened none. */
export function launchedTab(outcome: AgentTabLaunchOutcome) {
  return outcome && 'refused' in outcome ? null : outcome
}
