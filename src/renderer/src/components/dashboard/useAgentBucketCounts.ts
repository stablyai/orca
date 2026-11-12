import { useCallback } from 'react'
import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import { useAgentPresentation } from '../sidebar/workspace-card/activity/useWorktreeAgentRows'

export type AgentBucketCounts = Readonly<Record<DashboardBucket, number>>

export function useAgentBucketCounts(): AgentBucketCounts {
  return useAgentPresentation(
    'dashboard-counts',
    useCallback((projection) => projection.dashboardCounts(), [])
  )
}
