// @vitest-environment happy-dom

/** Preserve picker/search identity across loading, empty, no-match and failure states so refresh cannot erase the query/caret. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationsListPanel } from './AutomationsListPanel'
import {
  buildAutomationListViewItems,
  EMPTY_AUTOMATION_LIST_FILTER,
  type AutomationListSort,
  type AutomationListSortField
} from './automation-list-view'
import type { AutomationHostCatalogView } from './use-automation-host-catalog'
import { makeAutomationListRow } from './automations-page-fixtures'
import type { AutomationListRow } from './automation-list-row-identity'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import type { AutomationPaneTab } from './automation-page-state'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const HOST_CATALOG = {
  catalog: { entries: [], byStableKey: new Map(), hydration: {} },
  entries: [],
  resolution: {
    effective: { kind: 'all' },
    entry: null,
    status: 'all',
    announceFallback: false
  },
  rows: {
    rows: [],
    automations: [],
    capturedOwners: new Map(),
    groups: [],
    answered: true
  },
  loadCounts: { failedHostCount: 0, totalHostCount: 1 },
  selectHost: () => undefined,
  recover: () => undefined,
  refreshHosts: () => undefined,
  notifyAuthorityChange: () => undefined
} as unknown as AutomationHostCatalogView

function renderPanel(
  rows: readonly AutomationListRow[],
  query: string,
  onQueryChange: (next: string) => void = () => undefined,
  uncheckedNotice: string | null = null,
  options: {
    selectedRowKey?: string | null
    selectedExternalKey?: string | null
    onOpenDetail?: () => void
    selectAutomationRow?: (key: string | null) => void
    selectExternalKey?: (key: string | null) => void
    externalEntries?: readonly ExternalAutomationListEntry[]
    setActivePaneTab?: (tab: AutomationPaneTab) => void
    listSort?: AutomationListSort | null
    onListSortChange?: (field: AutomationListSortField) => void
  } = {}
): void {
  const externalEntries = options.externalEntries ?? []
  act(() => {
    root.render(
      <TooltipProvider>
        <AutomationsListPanel
          hasListItems={rows.length > 0 || externalEntries.length > 0}
          hasFilteredListItems={rows.length > 0 || externalEntries.length > 0}
          listFilter={EMPTY_AUTOMATION_LIST_FILTER}
          onListFilterChange={() => undefined}
          listSearchQuery={query}
          isListSearchQueryTooLarge={false}
          onListSearchQueryChange={onQueryChange}
          searchCounts={{
            hostRowCount: rows.length + externalEntries.length,
            visibleRowCount: rows.length + externalEntries.length,
            searchActive: query !== ''
          }}
          hostCatalog={HOST_CATALOG}
          canCreateAutomation={true}
          onOpenRuns={() => undefined}
          externalManagersUncheckedNotice={uncheckedNotice}
          onSelectHost={() => undefined}
          onRecoverHost={() => undefined}
          sortedListItems={buildAutomationListViewItems({
            rows,
            externalEntries
          })}
          listSort={options.listSort ?? null}
          onListSortChange={options.onListSortChange ?? (() => undefined)}
          selectedRowKey={options.selectedRowKey ?? null}
          selectedExternalKey={options.selectedExternalKey ?? null}
          relativeNow={0}
          repoMap={new Map()}
          worktreeMap={new Map()}
          projectHostSetups={[]}
          sshConnectionStates={new Map()}
          runtimeStatusByEnvironmentId={new Map()}
          hostTargetFor={() => null}
          isActionEnabled={() => true}
          externalActionKey={null}
          selectAutomationRow={options.selectAutomationRow ?? (() => undefined)}
          selectExternalKey={options.selectExternalKey ?? (() => undefined)}
          setActivePaneTab={options.setActivePaneTab ?? (() => undefined)}
          runNow={() => undefined}
          openEditDialog={() => undefined}
          toggleAutomation={() => undefined}
          requestDeleteAutomation={() => undefined}
          requestExternalAction={() => undefined}
          openCreateDialog={() => undefined}
          onOpenDetail={options.onOpenDetail ?? (() => undefined)}
          onRefresh={() => undefined}
          isRefreshing={false}
        />
      </TooltipProvider>
    )
  })
}

function searchField(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[aria-label="Search automations"]')
}

describe('AutomationsListPanel search field persistence', () => {
  it('survives a refresh tick that momentarily empties the list', () => {
    const row = makeAutomationListRow()
    renderPanel([row], 'night')
    const before = searchField()
    before?.focus()

    renderPanel([], 'night')

    // Identity, not presence: a remount is what loses the caret and the query.
    expect(searchField()).toBe(before)
    expect(searchField()?.value).toBe('night')
    expect(document.activeElement).toBe(before)
  })
})
