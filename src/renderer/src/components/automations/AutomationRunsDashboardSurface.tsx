import React from 'react'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { AutomationListRow } from './automation-list-row-identity'
import type {
  AutomationRunsDashboardEntry,
  AutomationRunsDashboardFailure
} from './automation-runs-dashboard-model'
import { AutomationRunsDashboard } from './AutomationRunsDashboard'
import type { AutomationsPageView } from './automation-page-state'

export function AutomationRunsDashboardSurface({
  rows,
  entries,
  failures,
  loading,
  hasMore,
  onLoadMore,
  now,
  onRefresh,
  setPageView,
  setRunPageOrigin,
  selectAutomationRow,
  setPendingAutomationRunNavigation,
  setIsDetailOpen
}: {
  rows: readonly AutomationListRow[]
  entries: readonly AutomationRunsDashboardEntry[]
  failures: readonly AutomationRunsDashboardFailure[]
  loading: boolean
  hasMore: boolean
  onLoadMore: () => void
  now: number
  onRefresh: () => void
  setPageView: (view: AutomationsPageView) => void
  setRunPageOrigin: (origin: 'runs' | 'automation') => void
  selectAutomationRow: (rowKey: string | null) => void
  setPendingAutomationRunNavigation: (navigation: {
    automationId: string
    runId: string | null
    hostId?: ExecutionHostId
  }) => void
  setIsDetailOpen: (open: boolean) => void
}): React.JSX.Element {
  return (
    <AutomationRunsDashboard
      rows={rows}
      entries={entries}
      failures={failures}
      loading={loading}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      now={now}
      onRefresh={onRefresh}
      onOpenRun={(entry) => {
        const authority = entry.row.catalogRef?.authority
        setRunPageOrigin('runs')
        setPageView('run')
        selectAutomationRow(entry.row.key)
        setPendingAutomationRunNavigation({
          automationId: entry.row.automation.id,
          runId: entry.run.id,
          hostId:
            authority?.kind === 'runtime'
              ? toRuntimeExecutionHostId(authority.environmentId)
              : undefined
        })
        setIsDetailOpen(true)
      }}
    />
  )
}
