import {
  dashboardCardBaseDisplayState,
  type DashboardBucket,
  type DashboardCard,
  type DashboardCardBaseDisplayState
} from '../../../../shared/dashboard-snapshot'

export function dashboardBucketForDotState(state: DashboardCardBaseDisplayState): DashboardBucket {
  switch (state) {
    case 'working':
    case 'monitoring':
      return 'working'
    case 'done':
      return 'done'
    case 'idle':
      return 'idle'
    case 'blocked':
    case 'waiting':
      return 'attention'
  }
}

// Why: agents usually ask in plain text then Stop (and bypass mode never emits PermissionRequest),
// so an unread finished turn is what needs the user; once acked it settles in Done, not Idle.
export function dashboardBucketForCard(
  card: Pick<DashboardCard, 'dotState' | 'workingMode' | 'unseen'>
): DashboardBucket {
  if (card.dotState === 'done') {
    return card.unseen ? 'attention' : 'done'
  }
  return dashboardBucketForDotState(dashboardCardBaseDisplayState(card))
}
