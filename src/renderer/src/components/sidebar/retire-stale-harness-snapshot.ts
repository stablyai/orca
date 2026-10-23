import type { AgentStatusState, AgentType } from '../../../../shared/agent-status-types'
import { shareCompatibleTitleIdentityGroup } from '../../../../shared/agent-title-owner'

/**
 * Whether a finished agent's snapshot no longer describes its pane because a different harness
 * family now occupies it (#24854). Same-group agents (OMP wrapping Pi) never retire.
 */
export function shouldRetireFinishedHarnessSnapshot(args: {
  finishedAgent: AgentType | null | undefined
  finishedState: AgentStatusState
  occupantAgent: AgentType | null | undefined
}): boolean {
  if (
    args.finishedState !== 'done' ||
    !args.occupantAgent ||
    !args.finishedAgent ||
    args.finishedAgent === 'unknown'
  ) {
    return false
  }
  return !shareCompatibleTitleIdentityGroup(args.finishedAgent, args.occupantAgent)
}
