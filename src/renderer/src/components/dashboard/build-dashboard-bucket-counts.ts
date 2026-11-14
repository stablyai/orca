import type { DashboardSnapshotState } from './build-dashboard-snapshot'

/** The accepted projection adjusts four totals from changed rows and workspace membership. */
export function buildDashboardBucketCounts(
  state: Pick<DashboardSnapshotState, 'agentStatusByPaneKey'>,
  _now: number
) {
  return state.agentStatusByPaneKey.projection.dashboardCounts()
}
