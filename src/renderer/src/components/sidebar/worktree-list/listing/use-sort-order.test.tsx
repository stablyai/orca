// @vitest-environment happy-dom

import { StrictMode, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import { useSidebarWorktreeSortOrder } from './use-sort-order'

// Main's list session is a runtime call with no bearing on the order.
vi.mock('@/lib/sidebar-list-session', () => ({ useSidebarListSession: () => {} }))

// The order names rows by host identity; these rows carry no host.
const keys = (...ids: string[]): string[] =>
  ids.map((id) => composeWorktreeHostIdentity(undefined, id))

const initialState = useAppStore.getInitialState()
const repo = makeRepo()
const repoMap = new Map([[repo.id, repo]])

function seed(worktrees: Worktree[], sortBy: SortBy): void {
  useAppStore.setState({ sortBy, worktreesByRepo: { [repo.id]: worktrees } })
}

function replaceWorktrees(worktrees: Worktree[]): void {
  useAppStore.setState({ worktreesByRepo: { [repo.id]: worktrees } })
}

// A row write that changes nothing the order reads.
function touchRows(): void {
  useAppStore.setState((s) => ({
    worktreesByRepo: {
      [repo.id]: (s.worktreesByRepo[repo.id] ?? []).map((worktree) => ({
        ...worktree,
        comment: `${worktree.comment}.`
      }))
    }
  }))
}

// Same shape as another client's order save landing here.
function publishSortOrders(sortOrderById: Record<string, number>): void {
  useAppStore.setState((s) => ({
    worktreesByRepo: {
      [repo.id]: (s.worktreesByRepo[repo.id] ?? []).map((worktree) => ({
        ...worktree,
        sortOrder: sortOrderById[worktree.id] ?? worktree.sortOrder
      }))
    }
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
    useAppStore.setState(initialState, true)
  })

  it('renders once per row write in Manual (no hook-initiated re-render)', () => {
    seed(
      [makeWorktree('a', 'A', { manualOrder: 2 }), makeWorktree('b', 'B', { manualOrder: 1 })],
      'manual'
    )
    const { renders } = renderSortOrder()
    const before = renders.count
    for (let i = 0; i < 10; i++) {
      act(() => touchRows())
    }
    expect(renders.count - before).toBe(10)
  })

  it('applies a Manual reorder in the same commit as the row write', () => {
    seed(
      [makeWorktree('a', 'A', { manualOrder: 2 }), makeWorktree('b', 'B', { manualOrder: 1 })],
      'manual'
    )
    const { result } = renderSortOrder({ strict: true })
    expect(result.current).toEqual(keys('a', 'b'))
    act(() =>
      replaceWorktrees([
        makeWorktree('a', 'A', { manualOrder: 2 }),
        makeWorktree('b', 'B', { manualOrder: 3 })
      ])
    )
    expect(result.current).toEqual(keys('b', 'a'))
  })

  it('survives a burst of synchronous row writes in Manual', () => {
    seed(
      [makeWorktree('a', 'A', { manualOrder: 2 }), makeWorktree('b', 'B', { manualOrder: 1 })],
      'manual'
    )
    const view = renderSortOrderOutsideAct('manual')
    try {
      for (let i = 0; i < 80; i++) {
        flushSync(() => touchRows())
      }
      expect(view.errors).toEqual([])
    } finally {
      view.unmount()
    }
  })

  it('survives 80 synchronous writes in Recent while worktrees are added, each applied in order', () => {
    let worktrees = [makeWorktree('w0', 'W0', { lastActivityAt: 0 })]
    seed(worktrees, 'recent')
    const view = renderSortOrderOutsideAct('recent')
    try {
      for (let i = 1; i <= 80; i++) {
        worktrees =
          i % 4 === 1
            ? [...worktrees, makeWorktree(`w${i}`, `W${i}`, { lastActivityAt: i * 100 })]
            : worktrees.map((w, index) => ({ ...w, lastActivityAt: i * 100 - index }))
        flushSync(() => replaceWorktrees(worktrees))
        const expected = [...worktrees]
          .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
          .map(getWorktreeHostIdentity)
        expect(view.latest.ids).toEqual(expected)
      }
      expect(view.latest.ids[0]).toBe(composeWorktreeHostIdentity(undefined, 'w0'))
      expect(view.errors).toEqual([])
    } finally {
      view.unmount()
    }
  })

  it('applies an added worktree at its sorted position', () => {
    seed([makeWorktree('a', 'A')], 'name')
    const { result } = renderSortOrder()
    act(() => replaceWorktrees([makeWorktree('a', 'A'), makeWorktree('0', '0 first')]))
    expect(result.current).toEqual(keys('0', 'a'))
  })

  it('re-sorts on Manual -> Recent', () => {
    seed(
      [
        makeWorktree('a', 'A', { manualOrder: 2, lastActivityAt: 1_000 }),
        makeWorktree('b', 'B', { manualOrder: 1, lastActivityAt: 2_000 })
      ],
      'manual'
    )
    const { result } = renderSortOrder()
    expect(result.current).toEqual(keys('a', 'b'))
    act(() => useAppStore.getState().setSortBy('recent'))
    expect(result.current).toEqual(keys('b', 'a'))
  })

  it('applies a removed worktree with the same write', () => {
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
    expect(result.current).toEqual(keys('c', 'b'))
  })

  it('follows another client order save while manual ranks by persisted sortOrder', () => {
    seed(
      [makeWorktree('a', 'A', { sortOrder: 2 }), makeWorktree('b', 'B', { sortOrder: 1 })],
      'manual'
    )
    const { result } = renderSortOrder()
    expect(result.current).toEqual(keys('a', 'b'))
    act(() => publishSortOrders({ a: 1, b: 2 }))
    expect(result.current).toEqual(keys('b', 'a'))
  })

  it('keeps Smart order steady and saves nothing when only persisted sortOrder changes', () => {
    const persistSortOrder = vi.fn(async () => ({ updated: 0 }))
    vi.stubGlobal('api', { worktrees: { persistSortOrder } })
    try {
      seed(
        [makeWorktree('a', 'A', { sortOrder: 2 }), makeWorktree('b', 'B', { sortOrder: 1 })],
        'smart'
      )
      const { result } = renderSortOrder()
      const before = result.current
      act(() => publishSortOrders({ a: 1, b: 2 }))
      expect(result.current).toBe(before)
      expect(persistSortOrder).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
