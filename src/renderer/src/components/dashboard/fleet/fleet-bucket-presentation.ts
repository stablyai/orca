import {
  dashboardCardDisplayState,
  type DashboardBucket,
  type DashboardCard,
  type DashboardCardBaseDisplayState
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'

export const FLEET_BUCKET_DOT_STATE: Record<DashboardBucket, DashboardCardBaseDisplayState> = {
  attention: 'waiting',
  working: 'working',
  done: 'done',
  idle: 'idle'
}

export function fleetCardSurfaceClass(card: DashboardCard): string {
  if (card.bucket === 'attention') {
    return 'border-agent-question/40 bg-agent-question/[0.06]'
  }
  return dashboardCardDisplayState(card) === 'done'
    ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
    : 'border-border/60 bg-card'
}
