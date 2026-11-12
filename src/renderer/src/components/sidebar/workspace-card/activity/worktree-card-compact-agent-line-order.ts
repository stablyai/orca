import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { agentRowStoppingLabel } from '@/lib/agent-status/presentation/agent-row-stopping-label'
import type { Translate } from '@/i18n/use-translate'

/** Lead with statuses the dot cannot express so truncation cuts the prompt instead; monitoring has its own glyph. */
export function getCompactAgentLineOrder(
  agent: DashboardAgentRowData,
  primary: string,
  secondary: string,
  t?: Translate
): { leadingText: string; trailingText: string } {
  const statusLeads = secondary === agentRowStoppingLabel(agent.entry, agent.state, t)
  const leadingText = statusLeads ? secondary : primary
  const trailingText = statusLeads ? primary : secondary
  return { leadingText, trailingText: trailingText === leadingText ? '' : trailingText }
}
