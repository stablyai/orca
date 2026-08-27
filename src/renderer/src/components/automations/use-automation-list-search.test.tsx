// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { makeAutomation, makeAutomationListRow, REPO_ID } from './automations-page-fixtures'
import type { AutomationListRow } from './automation-list-row-identity'
import { resolveAutomationListEmptyState } from './automation-list-empty-state'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'
import * as searchRows from './automation-list-search-rows'
import { useAutomationListSearch } from './use-automation-list-search'

// Why: the 50 ms budget is a claim about how often indexing runs, so the test
// counts index builds instead of timing them (a wall clock would flake in CI).
vi.mock('./automation-list-search-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof searchRows>()
  return {
    ...actual,
    buildAutomationListSearchRows: vi.fn(actual.buildAutomationListSearchRows),
    matchAutomationListSearchRowKeys: vi.fn(actual.matchAutomationListSearchRowKeys)
  }
})

const buildRowsSpy = vi.mocked(searchRows.buildAutomationListSearchRows)
const matchRowsSpy = vi.mocked(searchRows.matchAutomationListSearchRowKeys)

const repoMap = new Map([
  [REPO_ID, { id: REPO_ID, displayName: 'orca', path: '/src/orca' } as Repo]
])

type SearchResult = ReturnType<typeof useAutomationListSearch>

let container: HTMLDivElement
let root: Root
let latest: SearchResult | null = null

function Harness({ query, rows }: { query: string; rows: readonly AutomationListRow[] }): null {
  latest = useAutomationListSearch({
    listSearchQuery: query,
    rows,
    externalAutomationEntries: [],
    repoMap,
    selectedRowKey: null,
    selectedExternalKey: null,
    selectAutomationRow: () => undefined,
    selectExternalKey: () => undefined
  })
  return null
}

function render(query: string, rows: readonly AutomationListRow[]): void {
  act(() => {
    root.render(<Harness query={query} rows={rows} />)
  })
}

function makeRows(count: number): AutomationListRow[] {
  return Array.from({ length: count }, (_, index) =>
    makeAutomationListRow({
      automation: makeAutomation({
        id: `a-${index}`,
        name: `Automation ${index}`,
        prompt: `sweep repo ${index}`
      })
    })
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  buildRowsSpy.mockClear()
  matchRowsSpy.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  latest = null
})

describe('useAutomationListSearch index shape', () => {
  it('indexes the row set once and never again per keystroke', () => {
    render('', makeRows(20))
    const buildsAfterMount = buildRowsSpy.mock.calls.length

    // Fresh arrays per keystroke: a refresh tick mid-typing must not re-index.
    for (const query of ['s', 'sw', 'swe', 'swee', 'sweep']) {
      render(query, makeRows(20))
    }

    expect(buildRowsSpy.mock.calls.length).toBe(buildsAfterMount)
    expect(latest?.filteredRows).toHaveLength(20)
  })

  it('reuses the index when a refresh tick replaces rows with equal search content', () => {
    render('', makeRows(5))
    const buildsAfterMount = buildRowsSpy.mock.calls.length

    // New objects, new array, same searchable content — a nextRunAt-style tick.
    render(
      '',
      makeRows(5).map((row) => ({
        ...row,
        automation: { ...row.automation, nextRunAt: Date.now() }
      }))
    )

    expect(buildRowsSpy.mock.calls.length).toBe(buildsAfterMount)
  })

  it('rebuilds once when searchable content actually changes', () => {
    const automations = makeRows(5)
    render('', automations)
    const buildsAfterMount = buildRowsSpy.mock.calls.length

    const renamed = automations.map((row, index) =>
      index === 0 ? { ...row, automation: { ...row.automation, name: 'Renamed sweep' } } : row
    )
    render('', renamed)

    expect(buildRowsSpy.mock.calls.length).toBe(buildsAfterMount + 1)
  })

  it('matches in a single pass over prebuilt indexes per settled query', () => {
    const automations = makeRows(10)
    render('', automations)
    matchRowsSpy.mockClear()

    render('sweep repo 3', automations)

    // Two row sets (local + external), matched once each for the settled query.
    expect(matchRowsSpy.mock.calls.length).toBeLessThanOrEqual(2)
    expect(latest?.filteredRows.map((row) => row.automation.id)).toEqual(['a-3'])
  })
})

describe('useAutomationListSearch cross-host identity', () => {
  it('keeps both hosts’ copies of one automation ID through a matching query', () => {
    // Same ID under two authorities is legal (doc:38). Reconstructing the
    // filtered list from a bare-ID map silently returns one host's copy twice
    // and drops the other host's row from its group.
    const collided = [
      makeAutomationListRow({
        automation: makeAutomation({ id: 'a-1', name: 'Nightly desktop' })
      }),
      makeAutomationListRow({
        automation: makeAutomation({ id: 'a-1', name: 'Nightly web-01' }),
        hostStableKey: 'host:runtime:gpu:ssh:web-01',
        hostLabel: 'web-01'
      })
    ]
    render('nightly', collided)

    expect(latest?.filteredRows.map((row) => row.automation.name)).toEqual([
      'Nightly desktop',
      'Nightly web-01'
    ])
  })
})

describe('useAutomationListSearch counts', () => {
  it('reports rows before and after search for the empty-state view', () => {
    const automations = makeRows(4)
    render('', automations)
    expect(latest?.searchCounts).toEqual({
      hostRowCount: 4,
      visibleRowCount: 4,
      searchActive: false
    })

    render('no-such-automation', automations)
    expect(latest?.searchCounts).toEqual({
      hostRowCount: 4,
      visibleRowCount: 0,
      searchActive: true
    })
  })

  it('feeds the no-match empty state instead of letting it recompute counts', () => {
    const resolution: AutomationHostFilterResolution = {
      effective: { kind: 'all' },
      entry: null,
      status: 'all',
      announceFallback: false
    }
    render('no-such-automation', makeRows(3))
    const counts = latest?.searchCounts
    if (!counts) {
      throw new Error('hook produced no counts')
    }

    expect(resolveAutomationListEmptyState({ resolution, ...counts }).kind).toBe('search-no-match')
  })
})
