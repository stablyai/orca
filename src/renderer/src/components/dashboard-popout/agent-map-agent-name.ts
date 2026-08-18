import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'

export function agentName(card: DashboardCard): string {
  const legacyName =
    card.conversationNameExplicit === undefined
      ? card.conversationName?.trim() || card.task?.trim()
      : undefined
  return (
    card.orchestrationDisplayName?.trim() ||
    (card.conversationNameExplicit ? card.conversationName?.trim() : undefined) ||
    legacyName ||
    formatAgentTypeLabel(card.agentType)
  )
}
