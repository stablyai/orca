import type { AgentLaunchResult } from './agent-launch-intent'

export const AGENT_LAUNCH_CANCELLED_CODE = 'agent_launch_cancelled_before_admission'

export class AgentLaunchCancelledError extends Error {
  readonly code = AGENT_LAUNCH_CANCELLED_CODE
  constructor() {
    super(AGENT_LAUNCH_CANCELLED_CODE)
  }
}

export type AgentLaunchCancelResult = {
  status: 'cancelled' | 'admitted' | 'unknown'
  surfaceAdmitted?: true
  messageId?: string
  result?: AgentLaunchResult
}
