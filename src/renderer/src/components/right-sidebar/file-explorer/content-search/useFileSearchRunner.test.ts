// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SearchResult } from '../../../../../../shared/file-search/code-search-types'
import { useFileSearchRunner } from './useFileSearchRunner'

const WORKTREE_ID = 'wt-1'
const initial = useAppStore.getState()
const pending: { query: string; resolve: (result: SearchResult) => void }[] = []

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

function stored() {
  return useAppStore.getState().fileSearchStateByWorktree[WORKTREE_ID]
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

describe('text search runner publication', () => {
  const render = () =>
    renderHook(() =>
      useFileSearchRunner({
        activeWorktreeId: WORKTREE_ID,
        worktreePath: '/repo',
        updateActiveSearchState: (updates) =>
          useAppStore.getState().updateFileSearchState(WORKTREE_ID, updates)
      })
    )

  it('never publishes a scan that a newer query replaced', async () => {
    const { result } = render()
    act(() => result.current.executeSearch('cart'))
    await settle(300)
    act(() => result.current.executeSearch('cars'))
    await settle(300)
    expect(pending.map((request) => request.query)).toEqual(['cart', 'cars'])

    await act(async () => pending[0].resolve(resultFor('cart')))
    expect(stored()?.results).toBeNull()
    expect(stored()?.loading).toBe(true)

    await act(async () => pending[1].resolve(resultFor('cars')))
    expect(stored()?.results?.files[0].relativePath).toBe('cars.ts')
    expect(stored()?.query).toBe('cars')
    expect(stored()?.loading).toBe(false)
  })

  it('drops an in-flight scan once the query is cleared', async () => {
    const { result } = render()
    act(() => result.current.executeSearch('cart'))
    await settle(300)
    act(() => result.current.cancelPendingSearch())
    await act(async () => pending[0].resolve(resultFor('cart')))
    expect(stored()?.results).toBeNull()
    expect(stored()?.loading).toBe(false)
  })

  it('lets an explicit seed search one character', async () => {
    const { result } = render()
    act(() => result.current.executeSearch('x', { allowShortQuery: true }))
    await settle(300)
    expect(pending.map((request) => request.query)).toEqual(['x'])
  })
})
