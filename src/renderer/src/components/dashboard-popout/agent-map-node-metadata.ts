import {
  dashboardCardDisplayState,
  type DashboardCard,
  type DashboardCardDotState
} from '../../../../shared/dashboard-snapshot'

export function agentMapDurationMinutes(card: DashboardCard, now: number): number {
  if (!Number.isFinite(card.startedAt) || card.startedAt <= 0) {
    return 0
  }
  const end = card.finishedAt && card.finishedAt >= card.startedAt ? card.finishedAt : now
  return Math.max(0, (end - card.startedAt) / 60_000)
}

export function agentMapNodeStatus(card: DashboardCard): DashboardCardDotState {
  return dashboardCardDisplayState(card)
}
