import type { DashboardCard } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'

export function fleetCardTitle(card: DashboardCard): string {
  return card.conversationName ?? (card.task || card.worktreeName)
}
