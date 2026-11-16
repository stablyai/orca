import type { AgentMainAgentStatus } from './main-agent-status'
import type { AgentStatusState } from '../contracts/agent-status-types'

/** A physical sleep interrupts unfinished work and preserves an already accepted verdict. */
export function agentPaneSleepStatus<
  T extends { state: AgentStatusState; interrupted?: boolean; mainAgent?: AgentMainAgentStatus }
>(status: T, at: number): T {
  return status.state === 'done'
    ? status
    : {
        ...status,
        state: 'done',
        interrupted: true,
        ...(status.mainAgent
          ? { mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: at } }
          : {})
      }
}
