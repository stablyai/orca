// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { makeAutomation, makeAutomationListRow, REPO_ID } from './automations-page-fixtures'
import type { AutomationListRow } from './automation-list-row-identity'

import * as searchRows from './automation-list-search-rows'
import { useAutomationListSearch } from './use-automation-list-search'

// Count index builds instead of timing the 50ms claim to avoid CI timing flakes.
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

describe('useAutomationListSearch cross-host identity', () => {
  it('keeps both hosts’ copies of one automation ID through a matching query', () => {
    // Bare-ID reconstruction would duplicate one authority’s row and drop its colliding counterpart.
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
