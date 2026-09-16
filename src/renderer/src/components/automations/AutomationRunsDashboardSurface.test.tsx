// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { AutomationRunsDashboardEntry } from './automation-runs-dashboard-model'
import { makeAutomationListRow, makeRun } from './automations-page-fixtures'

let openRun: ((entry: AutomationRunsDashboardEntry) => void) | null = null

vi.mock('./AutomationRunsDashboard', () => ({
  AutomationRunsDashboard: (props: {
    entries: readonly AutomationRunsDashboardEntry[]
    onOpenRun: (entry: AutomationRunsDashboardEntry) => void
  }) => {
    openRun = props.onOpenRun
    return null
  }
}))

import { AutomationRunsDashboardSurface } from './AutomationRunsDashboardSurface'

describe('AutomationRunsDashboardSurface', () => {
  it('opens a run as a top-level page', () => {
    const row = makeAutomationListRow()
    const run = makeRun()
    const entry: AutomationRunsDashboardEntry = {
      key: `${row.key}:${run.id}`,
      hostKey: 'desktop:self',
      searchText: 'nightly',
      row,
      run,
      scope: 'local'
    }
    const setPageView = vi.fn()
    const setRunPageOrigin = vi.fn()
    const selectAutomationRow = vi.fn()
    const setPendingAutomationRunNavigation = vi.fn()
    const setIsDetailOpen = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <AutomationRunsDashboardSurface
          rows={[row]}
          entries={[entry]}
          failures={[]}
          loading={false}
          hasMore={false}
          onLoadMore={vi.fn()}
          now={0}
          onRefresh={vi.fn()}
          setPageView={setPageView}
          setRunPageOrigin={setRunPageOrigin}
          selectAutomationRow={selectAutomationRow}
          setPendingAutomationRunNavigation={setPendingAutomationRunNavigation}
          setIsDetailOpen={setIsDetailOpen}
        />
      )
    })

    act(() => openRun?.(entry))

    expect(setPageView).toHaveBeenCalledWith('run')
    expect(setRunPageOrigin).toHaveBeenCalledWith('runs')
    expect(selectAutomationRow).toHaveBeenCalledWith(row.key)
    expect(setPendingAutomationRunNavigation).toHaveBeenCalledWith({
      automationId: row.automation.id,
      runId: run.id,
      hostId: undefined
    })
    expect(setIsDetailOpen).toHaveBeenCalledWith(true)

    act(() => root.unmount())
  })
})
