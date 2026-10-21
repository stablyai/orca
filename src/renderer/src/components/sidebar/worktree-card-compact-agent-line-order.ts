import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { agentRowStoppingLabel } from '@/lib/agent-row-stopping-label'
import type { getAgentDotState } from './worktree-card-agent-summary'

/** The row's one line, lead first. A short status word the dot cannot carry leads, so the
 *  row's truncation cuts the prompt instead: monitoring, and a person's Stop ending the turn. */
export function getCompactAgentLineOrder(
  agent: DashboardAgentRowData,
  dotState: ReturnType<typeof getAgentDotState>,
  primary: string,
  secondary: string
): { leadingText: string; trailingText: string } {
  const statusLeads =
    dotState === 'monitoring' || secondary === agentRowStoppingLabel(agent.entry, agent.state)
  if (!statusLeads) {
    return { leadingText: primary, trailingText: secondary }
  }
  return { leadingText: secondary, trailingText: primary === secondary ? '' : primary }
}
