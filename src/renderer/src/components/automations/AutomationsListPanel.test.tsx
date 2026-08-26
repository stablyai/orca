// @vitest-environment happy-dom

/**
 * The list panel's persistent chrome: the picker and the search field stay put
 * across loading, empty, no-match, and failure states, so a refresh that briefly
 * returns no rows cannot take the query and the caret with it.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationsListPanel } from './AutomationsListPanel'
import { EMPTY_AUTOMATION_LIST_FILTER } from './automation-list-view'
import type { AutomationHostCatalogView } from './use-automation-host-catalog'
import { makeAutomation, makeAutomationListRow } from './automations-page-fixtures'
import type { AutomationListRow } from './automation-list-row-identity'

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
  rows: { rows: [], automations: [], capturedOwners: new Map(), groups: [], answered: true },
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
  uncheckedNotice: string | null = null
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <AutomationsListPanel
          hasListItems={rows.length > 0}
          hasFilteredListItems={rows.length > 0}
          listFilter={EMPTY_AUTOMATION_LIST_FILTER}
          onListFilterChange={() => undefined}
          listSearchQuery={query}
          isListSearchQueryTooLarge={false}
          onListSearchQueryChange={onQueryChange}
          searchCounts={{
            hostRowCount: rows.length,
            visibleRowCount: rows.length,
            searchActive: query !== ''
          }}
          hostCatalog={HOST_CATALOG}
          canCreateAutomation={true}
          externalManagersUncheckedNotice={uncheckedNotice}
          onSelectHost={() => undefined}
          onRecoverHost={() => undefined}
          filteredRows={rows}
          filteredExternalAutomationEntries={[]}
          selectedRowKey={null}
          selectedExternalKey={null}
          relativeNow={0}
          repoMap={new Map()}
          worktreeMap={new Map()}
          projectHostSetups={[]}
          sshConnectionStates={new Map()}
          runtimeStatusByEnvironmentId={new Map()}
          hostTargetFor={() => null}
          automationSourceHostAvailabilityByRowKey={new Map()}
          isActionEnabled={() => true}
          externalActionKey={null}
          selectAutomationRow={() => undefined}
          selectExternalKey={() => undefined}
          setActivePaneTab={() => undefined}
          runNow={() => undefined}
          openEditDialog={() => undefined}
          toggleAutomation={() => undefined}
          requestDeleteAutomation={() => undefined}
          requestExternalAction={() => undefined}
          openEditExternalDialog={() => undefined}
          openCreateDialog={() => undefined}
          onOpenDetail={() => undefined}
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
  it('keeps the search field on screen when the host has no rows', () => {
    renderPanel([], '')

    expect(searchField()).not.toBeNull()
  })

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

describe('AutomationsListPanel unchecked hosts', () => {
  it('shows a host it could not check instead of an unqualified empty list', () => {
    renderPanel(
      [],
      '',
      () => undefined,
      'External automation managers on web-01 could not be checked.'
    )

    expect(container.textContent).toContain(
      'External automation managers on web-01 could not be checked.'
    )
  })

  it('says nothing about unchecked hosts when there are none', () => {
    renderPanel([], '')

    expect(container.textContent).not.toContain('could not be checked')
  })
})

describe('AutomationsListPanel flat table layout', () => {
  it('renders table headers including Host column and displays row with host cell', () => {
    const row = makeAutomationListRow({
      hostLabel: 'Remote Linux',
      automation: makeAutomation({
        id: 'auto-1',
        name: 'Nightly Sync',
        agentId: 'codex',
        rrule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0',
        nextRunAt: 10000,
        lastRunAt: 5000,
        enabled: true
      })
    })
    renderPanel([row], '')

    expect(container.textContent).toContain('Name')
    expect(container.textContent).toContain('Schedule')
    expect(container.textContent).toContain('Project')
    expect(container.textContent).toContain('Host')
    expect(container.textContent).toContain('Nightly Sync')
    expect(container.textContent).toContain('Remote Linux')
  })
})
