import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { agentRowStoppingLabel } from '@/lib/agent-row-stopping-label'
import type { agentRowDisplayDotState as getAgentDotState } from '../../../../lib/agent-row-dot-state'
import type { Translate } from '@/i18n/use-translate'

/** Lead with statuses the dot cannot express so truncation cuts the prompt instead. */
export function getCompactAgentLineOrder(
  agent: DashboardAgentRowData,
  dotState: ReturnType<typeof getAgentDotState>,
  primary: string,
  secondary: string,
  t?: Translate
): { leadingText: string; trailingText: string } {
  const statusLeads =
    dotState === 'monitoring' || secondary === agentRowStoppingLabel(agent.entry, agent.state, t)
  if (!statusLeads) {
    return { leadingText: primary, trailingText: secondary }
  }
  return { leadingText: secondary, trailingText: primary === secondary ? '' : primary }
}
