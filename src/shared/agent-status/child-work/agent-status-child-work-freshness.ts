import type { AgentChildWorkMembership, AgentChildWorkState } from './agent-status-child-work'

export type AgentChildWorkFreshnessInput = {
  state: AgentChildWorkState
  membership: AgentChildWorkMembership
  parentEvidenceFresh: boolean
  transportObservation: 'live' | 'unverifiable'
}

/** One decay rule for CLI and structured children; freshness never rewrites settled history. */
export function resolveAgentChildWorkFreshness(
  input: AgentChildWorkFreshnessInput
): AgentChildWorkState {
  if (input.membership === 'settled' || input.state === 'idle' || input.state === 'done') {
    return input.state
  }
  return input.parentEvidenceFresh && input.transportObservation === 'live'
    ? input.state
    : 'unverifiable'
}
