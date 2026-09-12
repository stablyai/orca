// @vitest-environment happy-dom

/**
 * The All-hosts groups render a host that answered with nothing next to a host
 * nobody could ask. These tests pin the difference, because a shared "no rows"
 * sentence made the second read as the first — a claim about storage that no
 * request ever backed.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationListHostGroups } from './AutomationListHostGroups'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import { filterAutomationHostGroups } from './automation-host-list-rows'
import type { AutomationListRow } from './automation-list-row-identity'
import { makeAutomation, makeAutomationListRow } from './automations-page-fixtures'

vi.mock('./AutomationListLocalRows', () => ({
  AutomationListLocalRows: ({ rows }: { rows: readonly AutomationListRow[] }) => (
    <div data-testid="rows">{rows.map((row) => row.automation.name).join(',')}</div>
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

function entry(overrides: Partial<AutomationHostCatalogEntry> = {}): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 't1' } },
    owner: {
      authority: { kind: 'desktop' },
      selector: { kind: 'ssh', targetId: 't1', targetGeneration: 1 }
    },
    stableKey: 'host:desktop:ssh:t1',
    label: 'web-01',
    authorityLabel: 'This computer',
    kind: 'ssh',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

const roots: Root[] = []

async function render(options: {
  entry: AutomationHostCatalogEntry
  rows?: readonly AutomationListRow[]
  visibleRowKeys?: ReadonlySet<string>
  searchActive?: boolean
}): Promise<HTMLDivElement> {
  const rows = options.rows ?? []
  const groups = filterAutomationHostGroups(
    [
      {
        authorityKey: 'authority:desktop',
        authorityLabel: 'This computer',
        hosts: [{ entry: options.entry, rows }]
      }
    ],
    options.visibleRowKeys ?? new Set(rows.map((row) => row.key))
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <AutomationListHostGroups
        groups={groups}
        searchActive={options.searchActive ?? false}
        selectedRowKey={null}
        isSelectedLocal
        relativeNow={0}
        repoMap={new Map()}
        lastRunByAutomationId={new Map()}
        worktreeMap={new Map()}
        projectHostSetups={[]}
        sshConnectionStates={new Map()}
        runtimeStatusByEnvironmentId={new Map()}
        hostTargetFor={() => null}
        automationSourceHostAvailabilityByRowKey={new Map()}
        onSelect={vi.fn()}
        onRunNow={vi.fn()}
        onEdit={vi.fn()}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
        onRecover={vi.fn()}
      />
    )
  })
  return container
}

function emptyState(container: HTMLDivElement): { kind: string | null; text: string } {
  const node = container.querySelector('[data-empty-state]')
  return { kind: node?.getAttribute('data-empty-state') ?? null, text: node?.textContent ?? '' }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount())
  })
  document.body.innerHTML = ''
})

describe('AutomationListHostGroups empty groups', () => {
  it('does not claim an unreachable host holds no automations', async () => {
    const container = await render({ entry: entry({ authorityHealth: 'unavailable' }) })

    expect(emptyState(container).kind).toBe('host-unavailable')
    expect(container.textContent).not.toContain('No automations listed for this host')
    expect(emptyState(container).text).toContain('could not be loaded from web-01')
  })

  it('does not claim a disconnected host holds no automations', async () => {
    const container = await render({ entry: entry({ executionHealth: 'disconnected' }) })

    expect(emptyState(container).kind).toBe('host-not-connected')
    expect(emptyState(container).text).not.toContain('No automations')
  })

  it('does not claim an unhydrated host holds no automations', async () => {
    const container = await render({ entry: entry({ catalogState: 'unhydrated' }) })

    expect(emptyState(container).kind).toBe('host-loading')
    expect(emptyState(container).text).not.toContain('No automations')
  })

  it('blames the query when a search hid every row of a healthy host', async () => {
    const container = await render({
      entry: entry(),
      rows: [makeAutomationListRow({ automation: makeAutomation({ name: 'Nightly' }) })],
      visibleRowKeys: new Set<string>(),
      searchActive: true
    })

    expect(emptyState(container).kind).toBe('search-no-match')
    expect(emptyState(container).text).toBe('No automations match your search')
  })

  it('says a healthy connected host is empty, naming the host', async () => {
    const container = await render({ entry: entry() })

    expect(emptyState(container).kind).toBe('host-empty')
    expect(emptyState(container).text).toContain('No automations on web-01')
  })

  it('renders the rows a host did report', async () => {
    const container = await render({
      entry: entry(),
      rows: [makeAutomationListRow({ automation: makeAutomation({ name: 'Nightly' }) })]
    })

    expect(container.querySelector('[data-testid="rows"]')?.textContent).toBe('Nightly')
    expect(emptyState(container).kind).toBeNull()
  })
})
