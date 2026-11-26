// @vitest-environment happy-dom
// Perf contract (item 1892, one combined Files search): the name filter and text search share one field, so a
// keystroke must not publish to the store or start a text scan; only the pause after typing may, and only for
// queries of 2+ characters. Before, each keystroke published query/error/loading and 1-character queries scanned.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useFileSearchRunner } from './useFileSearchRunner'

const WORKTREE_ID = 'wt-1'
const initial = useAppStore.getState()
const search = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  search.mockReset()
  search.mockResolvedValue({ files: [], totalMatches: 0, truncated: false })
  Object.assign(window, {
    api: { ...window.api, fs: { search, cancelSearch: vi.fn(async () => undefined) } }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState(initial, true)
})

function renderRunner() {
  return renderHook(() =>
    useFileSearchRunner({
      activeWorktreeId: WORKTREE_ID,
      worktreePath: '/repo',
      updateActiveSearchState: (updates) =>
        useAppStore.getState().updateFileSearchState(WORKTREE_ID, updates)
    })
  )
}

function countSearchStatePublications(): { count: number; stop: () => void } {
  const counter = { count: 0 }
  const stop = useAppStore.subscribe((state, previous) => {
    if (state.fileSearchStateByWorktree !== previous.fileSearchStateByWorktree) {
      counter.count += 1
    }
  })
  return Object.assign(counter, { stop })
}

describe('combined search text runner work per keystroke', () => {
  it('publishes nothing while typing six characters, then runs one scan', async () => {
    const { result } = renderRunner()
    const publications = countSearchStatePublications()
    for (const query of ['c', 'ca', 'car', 'cart', 'cartS', 'cartSt']) {
      act(() => result.current.executeSearch(query))
      await act(async () => {
        vi.advanceTimersByTime(80)
      })
    }
    expect(publications.count).toBe(0)
    expect(search).toHaveBeenCalledTimes(0)

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][0]).toMatchObject({ query: 'cartSt' })
    // Start (query + loading), the result, and loading done.
    expect(publications.count).toBe(3)
    publications.stop()
  })

  it('never scans file contents for a one-character query', async () => {
    const { result } = renderRunner()
    act(() => result.current.executeSearch('c'))
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(search).toHaveBeenCalledTimes(0)
  })
})
