import React from 'react'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { AutomationListRow } from '../listing/automation-list-row-identity'
import type {
  AutomationRunsDashboardEntry,
  AutomationRunsDashboardFailure
} from './automation-runs-dashboard-model'
import { AutomationRunsDashboard } from './AutomationRunsDashboard'
import type { AutomationsPageView } from '../automation-page-state'
import type { PendingAutomationRunNavigation } from '../../../store/slices/ui/ui-slice-contract-core'
import { automationRowHostId } from '../automations-page-navigation'

export function AutomationRunsDashboardSurface({
  tabs,
  notice,
  rows,
  entries,
  failures,
  loading,
  hasMore,
  onLoadMore,
  now,
  worktreeForRun,
  setPageView,
  selectAutomationRow,
  setPendingAutomationRunNavigation,
  setIsDetailOpen
}: {
  tabs: React.ReactNode
  notice: React.ReactNode
  rows: readonly AutomationListRow[]
  entries: readonly AutomationRunsDashboardEntry[]
  failures: readonly AutomationRunsDashboardFailure[]
  loading: boolean
  hasMore: boolean
  onLoadMore: () => void
  now: number
  worktreeForRun: (entry: AutomationRunsDashboardEntry) => Worktree | null
  setPageView: (view: AutomationsPageView) => void
  selectAutomationRow: (rowKey: string | null) => void
  setPendingAutomationRunNavigation: (navigation: PendingAutomationRunNavigation) => void
  setIsDetailOpen: (open: boolean) => void
}): React.JSX.Element {
  return (
    <AutomationRunsDashboard
      tabs={tabs}
      notice={notice}
      rows={rows}
      entries={entries}
      failures={failures}
      loading={loading}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      now={now}
      worktreeForRun={worktreeForRun}
      onOpenRun={(entry) => {
        const hostId: ExecutionHostId | undefined = automationRowHostId(entry.row)
        setPageView('run')
        selectAutomationRow(entry.row.key)
        setPendingAutomationRunNavigation({
          automationId: entry.row.automation.id,
          runId: entry.run.id,
          hostId,
          origin: 'runs'
        })
        setIsDetailOpen(true)
      }}
    />
  )
}
