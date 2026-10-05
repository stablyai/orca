// @vitest-environment happy-dom

import { StrictMode, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import type { SortBy } from '../../smart-sort'
import { useSidebarWorktreeSortOrder } from './use-sort-order'

const initialState = useAppStore.getInitialState()
const repo = makeRepo()
const repoMap = new Map([[repo.id, repo]])

// Why a settled bump: the store's add/remove baseline is the row count at the last sortEpoch change.
function seed(worktrees: Worktree[], sortBy: SortBy): void {
  useAppStore.setState({
    sortBy,
    sortEpoch: 1,
    settledSortEpoch: 1,
    worktreesByRepo: { [repo.id]: worktrees }
  })
}

function bumpSortEpoch(): void {
  useAppStore.setState((s) => ({ sortEpoch: s.sortEpoch + 1 }))
}

function replaceWorktrees(worktrees: Worktree[]): void {
  useAppStore.setState((s) => ({
    worktreesByRepo: { [repo.id]: worktrees },
    sortEpoch: s.sortEpoch + 1
  }))
}

function renderSortOrder(options?: { strict?: boolean }) {
  const renders = { count: 0 }
  const hook = renderHook(
    () => {
      renders.count += 1
      const sortBy = useAppStore((s) => s.sortBy)
      return useSidebarWorktreeSortOrder({ repoMap, sortBy })
    },
    { wrapper: options?.strict ? StrictMode : undefined }
  )
  return { ...hook, renders }
}

function renderSortOrderOutsideAct(sortBy: SortBy) {
  const errors: unknown[] = []
  const latest: { ids: string[] } = { ids: [] }
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  const root = createRoot(document.createElement('div'), {
    onUncaughtError: (error) => errors.push(error),
    onCaughtError: (error) => errors.push(error)
  })
  function Probe(): null {
    latest.ids = useSidebarWorktreeSortOrder({ repoMap, sortBy })
    return null
  }
  flushSync(() => root.render(createElement(Probe)))
  return {
    errors,
    latest,
    unmount: () => {
      root.unmount()
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    }
  }
}

describe('useSidebarWorktreeSortOrder', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useAppStore.setState(initialState, true)
  })

  it('renders once per sortEpoch bump in Manual (no hook-initiated re-render)', () => {
    seed(
      [makeWorktree('a', 'A', { manualOrder: 2 }), makeWorktree('b', 'B', { manualOrder: 1 })],
      'manual'
    )
    const { renders } = renderSortOrder()
    const before = renders.count
    for (let i = 0; i < 10; i++) {
      act(() => bumpSortEpoch())
    }
    expect(renders.count - before).toBe(10)
  })

  it('applies a Manual reorder in the same commit as the bump', () => {
    seed(
      [makeWorktree('a', 'A', { manualOrder: 2 }), makeWorktree('b', 'B', { manualOrder: 1 })],
      'manual'
    )
    const { result } = renderSortOrder({ strict: true })
    expect(result.current).toEqual(['a', 'b'])
    act(() =>
      replaceWorktrees([
        makeWorktree('a', 'A', { manualOrder: 2 }),
        makeWorktree('b', 'B', { manualOrder: 3 })
      ])
    )
    expect(result.current).toEqual(['b', 'a'])
  })

  it('survives a burst of synchronous store bumps in Manual', () => {
    seed(
      [makeWorktree('a', 'A', { manualOrder: 2 }), makeWorktree('b', 'B', { manualOrder: 1 })],
      'manual'
    )
    const view = renderSortOrderOutsideAct('manual')
    try {
      for (let i = 0; i < 80; i++) {
        flushSync(() => bumpSortEpoch())
      }
      expect(view.errors).toEqual([])
    } finally {
      view.unmount()
    }
  })

  it('survives 80 synchronous bumps in Recent while worktrees are added, then settles in order', () => {
    vi.useFakeTimers()
    let worktrees = [makeWorktree('w0', 'W0', { lastActivityAt: 0 })]
    seed(worktrees, 'recent')
    const view = renderSortOrderOutsideAct('recent')
    try {
      for (let i = 1; i <= 80; i++) {
        if (i % 4 === 1) {
          // Why newest activity: a structural add must land at its sorted position (first) immediately.
          worktrees = [...worktrees, makeWorktree(`w${i}`, `W${i}`, { lastActivityAt: i * 100 })]
          flushSync(() => replaceWorktrees(worktrees))
          expect(view.latest.ids[0]).toBe(`w${i}`)
        } else {
          // Why reversed activity: these bumps reorder rows, so only the settle may apply them.
          worktrees = worktrees.map((w, index) => ({ ...w, lastActivityAt: i * 100 - index }))
          flushSync(() => replaceWorktrees(worktrees))
          flushSync(() => bumpSortEpoch())
        }
      }
      expect(view.latest.ids[0]).toBe('w77')
      expect(view.errors).toEqual([])
      flushSync(() => vi.advanceTimersByTime(3_000))
      expect(view.errors).toEqual([])
      const expected = [...useAppStore.getState().worktreesByRepo[repo.id]]
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .map((w) => w.id)
      expect(view.latest.ids).toEqual(expected)
      expect(view.latest.ids[0]).toBe('w0')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      view.unmount()
    }
  })

  it('debounces Recent re-sorts until the settle window passes', () => {
    vi.useFakeTimers()
    seed(
      [
        makeWorktree('a', 'A', { lastActivityAt: 2_000 }),
        makeWorktree('b', 'B', { lastActivityAt: 1_000 })
      ],
      'recent'
    )
    const { result } = renderSortOrder()
    expect(result.current).toEqual(['a', 'b'])
    act(() =>
      replaceWorktrees([
        makeWorktree('a', 'A', { lastActivityAt: 2_000 }),
        makeWorktree('b', 'B', { lastActivityAt: 3_000 })
      ])
    )
    expect(result.current).toEqual(['a', 'b'])
    act(() => vi.advanceTimersByTime(3_000))
    expect(result.current).toEqual(['b', 'a'])
  })

  it('applies an added worktree immediately in debounced modes', () => {
    vi.useFakeTimers()
    seed([makeWorktree('a', 'A')], 'name')
    const { result } = renderSortOrder()
    act(() => replaceWorktrees([makeWorktree('a', 'A'), makeWorktree('0', '0 first')]))
    expect(result.current).toEqual(['0', 'a'])
  })

  it('re-sorts on Manual -> Recent and stays put at settle', () => {
    vi.useFakeTimers()
    seed(
      [
        makeWorktree('a', 'A', { manualOrder: 2, lastActivityAt: 1_000 }),
        makeWorktree('b', 'B', { manualOrder: 1, lastActivityAt: 2_000 })
      ],
      'manual'
    )
    const { result } = renderSortOrder()
    for (let i = 0; i < 5; i++) {
      act(() => bumpSortEpoch())
    }
    expect(result.current).toEqual(['a', 'b'])
    act(() => useAppStore.getState().setSortBy('recent'))
    expect(result.current).toEqual(['b', 'a'])
    const afterSwitch = result.current
    act(() => vi.advanceTimersByTime(3_000))
    expect(result.current).toBe(afterSwitch)
  })

  it('restarts the settle window on every bump in a burst', () => {
    vi.useFakeTimers()
    seed(
      [
        makeWorktree('a', 'A', { lastActivityAt: 2_000 }),
        makeWorktree('b', 'B', { lastActivityAt: 1_000 })
      ],
      'recent'
    )
    const { result } = renderSortOrder()
    act(() =>
      replaceWorktrees([
        makeWorktree('a', 'A', { lastActivityAt: 2_000 }),
        makeWorktree('b', 'B', { lastActivityAt: 3_000 })
      ])
    )
    act(() => vi.advanceTimersByTime(2_000))
    act(() => bumpSortEpoch())
    act(() => vi.advanceTimersByTime(2_000))
    expect(result.current).toEqual(['a', 'b'])
    act(() => vi.advanceTimersByTime(1_000))
    expect(result.current).toEqual(['b', 'a'])
  })

  it('applies a removed worktree immediately in debounced modes', () => {
    vi.useFakeTimers()
    seed(
      [
        makeWorktree('a', 'A', { lastActivityAt: 3_000 }),
        makeWorktree('b', 'B', { lastActivityAt: 2_000 }),
        makeWorktree('c', 'C', { lastActivityAt: 1_000 })
      ],
      'recent'
    )
    const { result } = renderSortOrder()
    act(() =>
      replaceWorktrees([
        makeWorktree('b', 'B', { lastActivityAt: 2_000 }),
        makeWorktree('c', 'C', { lastActivityAt: 4_000 })
      ])
    )
    expect(result.current).toEqual(['c', 'b'])
  })

  it('does not re-sort when rows change without a sortEpoch bump', () => {
    vi.useFakeTimers()
    seed(
      [
        makeWorktree('a', 'A', { lastActivityAt: 2_000 }),
        makeWorktree('b', 'B', { lastActivityAt: 1_000 })
      ],
      'recent'
    )
    const { result } = renderSortOrder()
    const before = result.current
    // Same shape as a stale-host purge that drops/changes rows without bumping sortEpoch.
    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          [repo.id]: [
            makeWorktree('a', 'A', { lastActivityAt: 2_000 }),
            makeWorktree('b', 'B', { lastActivityAt: 3_000 }),
            makeWorktree('c', 'C', { lastActivityAt: 4_000 })
          ]
        }
      })
    )
    act(() => vi.advanceTimersByTime(3_000))
    expect(result.current).toBe(before)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('switching sort mode cancels a pending settle and re-sorts right away', () => {
    vi.useFakeTimers()
    seed(
      [
        makeWorktree('a', 'Zeta', { lastActivityAt: 2_000 }),
        makeWorktree('b', 'Alpha', { lastActivityAt: 1_000 })
      ],
      'recent'
    )
    const { result } = renderSortOrder()
    act(() =>
      replaceWorktrees([
        makeWorktree('a', 'Zeta', { lastActivityAt: 2_000 }),
        makeWorktree('b', 'Alpha', { lastActivityAt: 3_000 })
      ])
    )
    expect(vi.getTimerCount()).toBe(1)
    act(() => useAppStore.getState().setSortBy('name'))
    expect(result.current).toEqual(['b', 'a'])
    expect(useAppStore.getState().settledSortEpoch).toBe(useAppStore.getState().sortEpoch)
    expect(vi.getTimerCount()).toBe(0)
  })
})
