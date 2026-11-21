import type { AgentMainAgentStatus } from './main-agent-status'
import type { AgentStatusState } from '../contracts/agent-status-types'

/** A physical sleep interrupts unfinished work and preserves an already accepted verdict. */
export function agentPaneSleepStatus<
  T extends { state: AgentStatusState; interrupted?: boolean; mainAgent?: AgentMainAgentStatus }
>(status: T, at: number): T {
  if (status.state === 'done') {
    return status
  }
  // Only the main agent's own turn can be cancelled; a finished one keeps its verdict.
  return status.mainAgent?.state === 'done'
    ? { ...status, state: 'done' }
    : {
        ...status,
        state: 'done',
        interrupted: true,
        ...(status.mainAgent
          ? { mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: at } }
          : {})
      }
}
