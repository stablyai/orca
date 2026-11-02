// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import { SORT_SETTLE_MS } from '../../../../../../shared/sidebar-list/sort-settle'
import { SLEEPING_SWEEP_SETTLE_MS } from '../../../../../../shared/sidebar-list/sleeping-sweep-retention'
import { getWorktreeIdFromHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { SidebarClock } from '../../../../../../main/runtime/sidebar-inputs/sidebar-clock'
import { SidebarTemporalOwner } from '../../../../../../main/runtime/sidebar-inputs/sidebar-temporal-owner'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import { makeTerminalTab } from '../../../../store/slices/worktrees-slice-test-fixtures'
import { useSidebarWorktreeSortOrder } from './use-sort-order'
import { useSleepingSweepRetention } from './use-sleeping-sweep-retention'

// Main never persists ranks in shadow, so the window's write is not part of the comparison.
vi.mock('@/lib/worktree-sort-order-persistence', () => ({
  persistWorktreeSortOrderByHost: vi.fn()
}))

const initialState = useAppStore.getInitialState()
const repo = makeRepo()
const repoMap = new Map([[repo.id, repo]])

/** Main's owner over the window's own store, so only the time rules can differ. */
function mainOwner(): SidebarTemporalOwner {
  return new SidebarTemporalOwner(new SidebarClock(), {
    sortBy: () => useAppStore.getState().sortBy,
    showSleepingWorkspaces: () => useAppStore.getState().showSleepingWorkspaces,
    readSortSample: async () => {
      const state = useAppStore.getState()
      return { worktrees: state.worktreesByRepo[repo.id] ?? [], repoMap, sources: state }
    },
    retentionCandidates: () => {
      const state = useAppStore.getState()
      const live = (id: string): boolean =>
        (state.tabsByWorktree[id] ?? []).some((tab) => (state.ptyIdsByTabId[tab.id] ?? []).length)
      return {
        ids: (state.worktreesByRepo[repo.id] ?? []).map((w) => w.id),
        isActive: live,
        isUnverifiableGap: (id) => (state.tabsByWorktree[id]?.length ?? 0) > 0
      }
    }
  })
}

function renderWindow() {
  return renderHook(() => {
    const sortBy = useAppStore((s) => s.sortBy)
    return useSidebarWorktreeSortOrder({ repoMap, sortBy })
  })
}

const mainRanks = (owner: SidebarTemporalOwner): string[] | undefined =>
  owner.snapshot().sortSnapshot?.rankedIds.map(getWorktreeIdFromHostIdentity)

/** One sort-input change, landing in both: the window's sortEpoch and main's settle window. */
function change(
  owner: SidebarTemporalOwner,
  patch: Partial<ReturnType<typeof useAppStore.getState>>
) {
  act(() => useAppStore.setState((s) => ({ ...patch, sortEpoch: s.sortEpoch + 1 })))
  owner.noteSortInputChange()
}

async function advance(ms: number): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

function seed(worktrees: Worktree[], sortBy: SortBy): void {
  useAppStore.setState({
    sortBy,
    sortEpoch: 1,
    settledSortEpoch: 1,
    worktreesByRepo: { [repo.id]: worktrees }
  })
}

describe('main temporal owner against the window, on one fake clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000_000)
    useAppStore.setState(initialState, true)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useAppStore.setState(initialState, true)
  })

  it('settles a Recent burst at the same moment and to the same order', async () => {
    seed(
      [
        makeWorktree('a', 'A', { lastActivityAt: 3 }),
        makeWorktree('b', 'B', { lastActivityAt: 2 }),
        makeWorktree('c', 'C', { lastActivityAt: 1 })
      ],
      'recent'
    )
    const owner = mainOwner()
    const window = renderWindow()
    owner.beginSession('s1')
    owner.noteCatalogListing(useAppStore.getState().worktreesByRepo[repo.id] ?? [], false)
    await advance(0)
    expect(mainRanks(owner)).toEqual(window.result.current)

    const bumped = (id: string, at: number): Worktree[] =>
      (useAppStore.getState().worktreesByRepo[repo.id] ?? []).map((w) =>
        w.id === id ? { ...w, lastActivityAt: at } : w
      )
    change(owner, { worktreesByRepo: { [repo.id]: bumped('c', 10) } })
    await advance(1_000)
    change(owner, { worktreesByRepo: { [repo.id]: bumped('b', 11) } })
    await advance(SORT_SETTLE_MS - 1)
    expect(window.result.current).toEqual(['a', 'b', 'c'])
    expect(mainRanks(owner)).toEqual(window.result.current)
    await advance(1)
    expect(window.result.current).toEqual(['b', 'c', 'a'])
    expect(mainRanks(owner)).toEqual(window.result.current)
  })

  it('waits out a burst when a listing brings only fresher activity, as the window does', async () => {
    seed(
      [
        makeWorktree('a', 'A', { lastActivityAt: 2 }),
        makeWorktree('b', 'B', { lastActivityAt: 1 })
      ],
      'recent'
    )
    const owner = mainOwner()
    const window = renderWindow()
    owner.beginSession('s1')
    await advance(0)
    expect(mainRanks(owner)).toEqual(window.result.current)

    // The window bumps once; the activity write on the row it shows reorders nothing by itself.
    change(owner, {})
    act(() =>
      useAppStore.setState((s) => ({
        worktreesByRepo: {
          [repo.id]: (s.worktreesByRepo[repo.id] ?? []).map((w) =>
            w.id === 'b' ? { ...w, lastActivityAt: 9 } : w
          )
        }
      }))
    )
    owner.noteCatalogListing(useAppStore.getState().worktreesByRepo[repo.id] ?? [], false)
    await advance(SORT_SETTLE_MS - 1)
    expect(window.result.current).toEqual(['a', 'b'])
    expect(mainRanks(owner)).toEqual(window.result.current)
    await advance(1)
    expect(window.result.current).toEqual(['b', 'a'])
    expect(mainRanks(owner)).toEqual(window.result.current)
  })

  it('latches Smart on the same live signal and both go cold on a remount', async () => {
    seed(
      [
        makeWorktree('a', 'A', { sortOrder: 2, lastActivityAt: 1 }),
        makeWorktree('b', 'B', { sortOrder: 1, lastActivityAt: 9 })
      ],
      'smart'
    )
    const owner = mainOwner()
    let window = renderWindow()
    owner.beginSession('s1')
    owner.noteCatalogListing(useAppStore.getState().worktreesByRepo[repo.id] ?? [], false)
    await advance(0)
    expect(window.result.current).toEqual(['a', 'b'])
    expect(mainRanks(owner)).toEqual(window.result.current)

    change(owner, {
      tabsByWorktree: { b: [makeTerminalTab({ id: 'tab-b', worktreeId: 'b' })] },
      ptyIdsByTabId: { 'tab-b': ['pty-b'] }
    })
    await advance(SORT_SETTLE_MS)
    expect(window.result.current).toEqual(['b', 'a'])
    expect(mainRanks(owner)).toEqual(window.result.current)

    change(owner, { ptyIdsByTabId: {} })
    await advance(SORT_SETTLE_MS)
    expect(mainRanks(owner)).toEqual(window.result.current)

    window.unmount()
    window = renderWindow()
    owner.beginSession('s2')
    await advance(0)
    expect(window.result.current).toEqual(['a', 'b'])
    expect(mainRanks(owner)).toEqual(window.result.current)
  })

  it('keeps and releases the same sleeping rows', async () => {
    seed([makeWorktree('a', 'A'), makeWorktree('b', 'B')], 'name')
    act(() =>
      useAppStore.setState({
        showSleepingWorkspaces: false,
        tabsByWorktree: { a: [makeTerminalTab({ id: 'tab-a', worktreeId: 'a' })] },
        ptyIdsByTabId: { 'tab-a': ['pty-a'] }
      })
    )
    const owner = mainOwner()
    owner.beginSession('s1')
    await advance(0)
    const window = renderHook(() =>
      useSleepingSweepRetention({
        enabled: !useAppStore((s) => s.showSleepingWorkspaces),
        worktreesByRepo: useAppStore((s) => s.worktreesByRepo),
        tabsByWorktree: useAppStore((s) => s.tabsByWorktree),
        ptyIdsByTabId: useAppStore((s) => s.ptyIdsByTabId),
        browserTabsByWorktree: {},
        worktreeIdsWithLiveAgent: new Set(),
        worktreeIdsWithStructuredChat: new Set()
      })
    )
    const mainRetained = (): string[] =>
      (owner.snapshot().retention?.retainedIds ?? []).map(getWorktreeIdFromHostIdentity)

    act(() => useAppStore.setState({ ptyIdsByTabId: {} }))
    owner.noteActivityChange()
    expect([...(window.result.current ?? [])]).toEqual(['a'])
    expect(mainRetained()).toEqual(['a'])

    await advance(SLEEPING_SWEEP_SETTLE_MS)
    expect([...(window.result.current ?? [])]).toEqual([])
    expect(mainRetained()).toEqual([])
  })
})
