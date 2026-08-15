import type { DashboardBucket, DashboardCardDotState } from '../../../../shared/dashboard-snapshot'

export function dashboardBucketForDotState(state: DashboardCardDotState): DashboardBucket {
  switch (state) {
    case 'working':
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
