// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SearchResult } from '../../../../../../shared/file-search/code-search-types'
import { getInitialSearchDraft } from './use-search-draft-lifecycle'
import { useCombinedSearch } from './useCombinedSearch'

const initial = useAppStore.getState()
const pending: { query: string; resolve: (result: SearchResult) => void }[] = []
const noop = (): void => {}

function resultFor(query: string): SearchResult {
  return {
    totalMatches: 1,
    truncated: false,
    files: [
      {
        filePath: `/repo/${query}.ts`,
        relativePath: `${query}.ts`,
        matches: [{ line: 1, column: 1, matchLength: query.length, lineContent: query }]
      }
    ]
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  pending.length = 0
  Object.assign(window, {
    api: {
      ...window.api,
      fs: {
        search: (options: { query: string }) =>
          new Promise<SearchResult>((resolve) => pending.push({ query: options.query, resolve })),
        cancelSearch: async () => undefined
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState(initial, true)
})

/** The search field as the Files pane mounts it: keyed per worktree, opening on its initial draft. */
function renderField(worktreeId: string) {
  return renderHook(() => {
    const [start] = useState(() => getInitialSearchDraft(worktreeId))
    const [query, setQuery] = useState(start.text)
    return useCombinedSearch({
      activeWorktreeId: worktreeId,
      worktreePath: '/repo',
      query,
      setQuery,
      nameMatches: { total: 0, matches: [] },
      namesLoading: false,
      namesError: null,
      onOpenName: noop,
      onShowAllNames: noop,
      initial: start
    })
  })
}

type Field = ReturnType<typeof renderField>['result']

function textRowKeys(result: Field): string[] {
  const { model } = result.current.results
  return Array.from({ length: model.count }, (_, index) => model.getKey(index)).filter(
    (key) => key.startsWith('file:') || key.startsWith('match:')
  )
}

async function pause(ms = 300): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

describe('combined search text state', () => {
  it('scans a one-character query seeded on a cold open exactly once', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-seed' })
    useAppStore.getState().showRightSidebarSearch({ query: 'x' })
    const { result } = renderField('wt-seed')
    expect(result.current.field.query).toBe('x')
    await pause(1000)
    expect(pending.map((request) => request.query)).toEqual(['x'])
    await act(async () => pending[0].resolve(resultFor('x')))
    expect(textRowKeys(result)).toEqual(['file:/repo/x.ts', 'match:/repo/x.ts:1:1:0'])
  })

  it('never keeps the previous query rows while the next scan runs', async () => {
    const { result } = renderField('wt-stale')
    act(() => result.current.field.onQueryChange('cart'))
    await pause()
    await act(async () => pending[0].resolve(resultFor('cart')))
    expect(textRowKeys(result)).toHaveLength(2)

    act(() => result.current.field.onQueryChange('cars'))
    expect(textRowKeys(result)).toEqual([])
    await pause()
    expect(pending.map((request) => request.query)).toEqual(['cart', 'cars'])
    expect(textRowKeys(result)).toEqual([])
    expect(result.current.field.loading).toBe(true)
  })

  it('reopens on the newest draft, not the last searched query', async () => {
    const first = renderField('wt-remount')
    act(() => first.result.current.field.onQueryChange('cart'))
    await pause()
    await act(async () => pending[0].resolve(resultFor('cart')))
    act(() => first.result.current.field.onQueryChange('cars'))
    first.unmount()

    const second = renderField('wt-remount')
    expect(second.result.current.field.query).toBe('cars')
    await pause()
    expect(pending.at(-1)?.query).toBe('cars')
  })
})
