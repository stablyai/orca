import type { AgentDotState } from '@/components/AgentStateDot'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { agentRowDotState } from '@/lib/agent-row-dot-state'
import { dashboardCardDisplayState } from '../../../../shared/dashboard-snapshot'

/**
 * Keep the sidebar's raw agent status intact while matching the dashboard's
 * acknowledgement presentation: a fresh completion is Done, and a completion
 * the user has visited settles to Idle.
 */
export function worktreeAgentDisplayState(
  agent: DashboardAgentRow,
  isUnvisited: boolean
): AgentDotState {
  if (agent.entry.interrupted === true) {
    return 'interrupted'
  }
  if (agent.state !== 'done') {
    return agentRowDotState(agent.state, agent.entry.workingMode)
  }
  return dashboardCardDisplayState({
    dotState: 'done',
    workingMode: agent.entry.workingMode,
    unseen: isUnvisited
  })
}
