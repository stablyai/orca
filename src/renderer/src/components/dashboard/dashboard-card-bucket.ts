import {
  dashboardCardDisplayState,
  type DashboardCard,
  type DashboardBucket,
  type DashboardCardDisplayState
} from '../../../../shared/dashboard-snapshot'

export function dashboardBucketForDotState(state: DashboardCardDisplayState): DashboardBucket {
  switch (state) {
    case 'working':
    case 'monitoring':
      return 'working'
    case 'interrupted':
    case 'done':
      return 'done'
    case 'idle':
      return 'idle'
    case 'blocked':
    case 'waiting':
      return 'attention'
  }
}

/** Acknowledgment changes placement, not the recorded terminal outcome. */
export function dashboardCardBucket(
  card: Pick<DashboardCard, 'dotState' | 'workingMode' | 'interrupted' | 'unseen'>
): DashboardBucket {
  if (card.dotState === 'done' && !card.unseen) {
    return 'idle'
  }
  return dashboardBucketForDotState(dashboardCardDisplayState(card))
}
