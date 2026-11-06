// @vitest-environment happy-dom

import { StrictMode, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import { useSidebarWorktreeSortOrder } from './use-sort-order'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import { makeTerminalTab } from '../../../../store/slices/worktrees-slice-test-fixtures'

// The sort ranks each card by host identity; these rows carry no host.
const key = (id: string): string => composeWorktreeHostIdentity(undefined, id)
const keys = (...ids: string[]): string[] => ids.map(key)

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

// Same shape as another client's order save landing here: sortOrder changes, sortEpoch does not.
function publishSortOrders(sortOrderById: Record<string, number>): void {
  useAppStore.setState((s) => ({
    worktreesByRepo: {
      [repo.id]: (s.worktreesByRepo[repo.id] ?? []).map((worktree) => ({
        ...worktree,
        sortOrder: sortOrderById[worktree.id] ?? worktree.sortOrder
      }))
    },
    sortOrderEpoch: s.sortOrderEpoch + 1
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
          expect(view.latest.ids[0]).toBe(key(`w${i}`))
        } else {
          // Why reversed activity: these bumps reorder rows, so only the settle may apply them.
          worktrees = worktrees.map((w, index) => ({ ...w, lastActivityAt: i * 100 - index }))
          flushSync(() => replaceWorktrees(worktrees))
          flushSync(() => bumpSortEpoch())
        }
      }
      expect(view.latest.ids[0]).toBe(key('w77'))
      expect(view.errors).toEqual([])
      flushSync(() => vi.advanceTimersByTime(3_000))
      expect(view.errors).toEqual([])
      const expected = [...useAppStore.getState().worktreesByRepo[repo.id]]
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .map(getWorktreeHostIdentity)
      expect(view.latest.ids).toEqual(expected)
      expect(view.latest.ids[0]).toBe(key('w0'))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      view.unmount()
    }
  })

  it('keeps Smart latched after its live signal ends, until the list unmounts', () => {
    vi.stubGlobal('api', { worktrees: { persistSortOrder: vi.fn(async () => ({ updated: 0 })) } })
    try {
      seed(
        [makeWorktree('a', 'A', { sortOrder: 2 }), makeWorktree('b', 'B', { sortOrder: 1 })],
        'smart'
      )
      useAppStore.setState({
        tabsByWorktree: { a: [makeTerminalTab({ id: 'tab-a', worktreeId: 'a' })] },
        ptyIdsByTabId: { 'tab-a': ['pty-a'] }
      })
      const latched = renderSortOrder()
      act(() => useAppStore.setState({ ptyIdsByTabId: {} }))
      const before = latched.result.current
      act(() => publishSortOrders({ a: 1, b: 2 }))
      expect(latched.result.current).toBe(before)
      latched.unmount()

      const cold = renderSortOrder()
      expect(cold.result.current).toEqual(keys('b', 'a'))
      act(() => publishSortOrders({ a: 3 }))
      expect(cold.result.current).toEqual(keys('a', 'b'))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
