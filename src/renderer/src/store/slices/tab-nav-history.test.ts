import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { Tab } from '../../../../shared/types'
import {
  canGoBackTabHistory,
  canGoForwardTabHistory,
  createTabNavHistorySlice
} from './tab-nav-history'

type MinimalState = Pick<
  AppState,
  | 'tabNavHistoryByWorktree'
  | 'isNavigatingTabHistory'
  | 'recordTabVisit'
  | 'goBackTabHistory'
  | 'goForwardTabHistory'
  | 'unifiedTabsByWorktree'
  | 'activateTab'
  | 'getActiveTab'
>

function makeTab(id: string): Tab {
  // Only `id` is read by the slice's live-entry checks; cast covers irrelevant fields.
  return { id } as unknown as Tab
}

function createTabHistoryStore(
  tabIdsByWorktree: Record<string, string[]>,
  opts: { activeTabId?: string | null } = {}
): { store: StoreApi<MinimalState>; activateTab: ReturnType<typeof vi.fn> } {
  const activateTab = vi.fn()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = createStore<any>()((set, get, api) => ({
    unifiedTabsByWorktree: Object.fromEntries(
      Object.entries(tabIdsByWorktree).map(([worktreeId, tabIds]) => [
        worktreeId,
        tabIds.map(makeTab)
      ])
    ),
    activateTab,
    getActiveTab: () => (opts.activeTabId ? makeTab(opts.activeTabId) : null),
    ...createTabNavHistorySlice(
      set as Parameters<typeof createTabNavHistorySlice>[0],
      get as Parameters<typeof createTabNavHistorySlice>[1],
      api as Parameters<typeof createTabNavHistorySlice>[2]
    )
  })) as unknown as StoreApi<MinimalState>
  return { store, activateTab }
}

describe('tab-nav-history slice: recordTabVisit', () => {
  it('appends entries per worktree and advances the index', () => {
    const { store } = createTabHistoryStore({ wt: ['t1', 't2', 't3'] })
    store.getState().recordTabVisit('wt', 't1')
    store.getState().recordTabVisit('wt', 't2')
    store.getState().recordTabVisit('wt', 't3')

    expect(store.getState().tabNavHistoryByWorktree.wt).toEqual({
      entries: ['t1', 't2', 't3'],
      index: 2
    })
  })

  it('seeds an empty stack with the outgoing active tab so the first switch has a Back target', () => {
    const { store } = createTabHistoryStore({ wt: ['t1', 't2'] }, { activeTabId: 't1' })
    store.getState().recordTabVisit('wt', 't2')

    expect(store.getState().tabNavHistoryByWorktree.wt).toEqual({
      entries: ['t1', 't2'],
      index: 1
    })
  })

  it('de-dupes only the current entry (A -> B -> A is valid)', () => {
    const { store } = createTabHistoryStore({ wt: ['a', 'b'] })
    store.getState().recordTabVisit('wt', 'a')
    store.getState().recordTabVisit('wt', 'a')
    store.getState().recordTabVisit('wt', 'b')
    store.getState().recordTabVisit('wt', 'a')

    expect(store.getState().tabNavHistoryByWorktree.wt?.entries).toEqual(['a', 'b', 'a'])
  })

  it('keeps worktree stacks independent', () => {
    const { store } = createTabHistoryStore({ w1: ['a'], w2: ['b'] })
    store.getState().recordTabVisit('w1', 'a')
    store.getState().recordTabVisit('w2', 'b')

    expect(store.getState().tabNavHistoryByWorktree.w1?.entries).toEqual(['a'])
    expect(store.getState().tabNavHistoryByWorktree.w2?.entries).toEqual(['b'])
  })

  it('skips recording while navigating history', () => {
    const { store } = createTabHistoryStore({ wt: ['a', 'b'] })
    store.getState().recordTabVisit('wt', 'a')
    store.setState({ isNavigatingTabHistory: true } as Partial<MinimalState>)
    store.getState().recordTabVisit('wt', 'b')

    expect(store.getState().tabNavHistoryByWorktree.wt?.entries).toEqual(['a'])
  })
})

describe('tab-nav-history slice: goBack/goForward', () => {
  it('walks back then forward, activating the target tab (visit 1,2,3 -> back -> 2)', () => {
    const { store, activateTab } = createTabHistoryStore({ wt: ['t1', 't2', 't3'] })
    store.getState().recordTabVisit('wt', 't1')
    store.getState().recordTabVisit('wt', 't2')
    store.getState().recordTabVisit('wt', 't3')

    store.getState().goBackTabHistory('wt')
    expect(activateTab).toHaveBeenLastCalledWith('t2')

    store.getState().goForwardTabHistory('wt')
    expect(activateTab).toHaveBeenLastCalledWith('t3')
  })

  it('truncates the forward branch on a new visit (1,2,3 -> back -> visit 4 -> back is 2)', () => {
    const { store, activateTab } = createTabHistoryStore({ wt: ['t1', 't2', 't3', 't4'] })
    const state = store.getState()
    state.recordTabVisit('wt', 't1')
    state.recordTabVisit('wt', 't2')
    state.recordTabVisit('wt', 't3')

    store.getState().goBackTabHistory('wt')
    expect(activateTab).toHaveBeenLastCalledWith('t2')
    // Why: the real activateTab records the history-driven visit but the slice's flag suppresses it; simulate a user visit here.
    store.getState().recordTabVisit('wt', 't4')

    expect(store.getState().tabNavHistoryByWorktree.wt?.entries).toEqual(['t1', 't2', 't4'])

    store.getState().goBackTabHistory('wt')
    expect(activateTab).toHaveBeenLastCalledWith('t2')
    store.getState().goForwardTabHistory('wt')
    expect(activateTab).toHaveBeenLastCalledWith('t4')
  })

  it('skips closed tabs when walking', () => {
    const { store, activateTab } = createTabHistoryStore({ wt: ['t1', 't3'] })
    store.getState().recordTabVisit('wt', 't1')
    store.getState().recordTabVisit('wt', 't2')
    store.getState().recordTabVisit('wt', 't3')

    // t2 is not in unifiedTabsByWorktree (closed) — back lands on t1.
    store.getState().goBackTabHistory('wt')
    expect(activateTab).toHaveBeenLastCalledWith('t1')
  })

  it('no-ops at the boundaries and reports canGo correctly', () => {
    const { store, activateTab } = createTabHistoryStore({ wt: ['t1', 't2'] })
    expect(canGoBackTabHistory(store.getState() as AppState, 'wt')).toBe(false)

    store.getState().recordTabVisit('wt', 't1')
    store.getState().recordTabVisit('wt', 't2')
    expect(canGoBackTabHistory(store.getState() as AppState, 'wt')).toBe(true)
    expect(canGoForwardTabHistory(store.getState() as AppState, 'wt')).toBe(false)

    store.getState().goForwardTabHistory('wt')
    expect(activateTab).not.toHaveBeenCalled()

    store.getState().goBackTabHistory('wt')
    expect(canGoForwardTabHistory(store.getState() as AppState, 'wt')).toBe(true)
    store.getState().goBackTabHistory('wt')
    expect(activateTab).toHaveBeenCalledTimes(1)
  })

  it('restores the navigating flag after activation', () => {
    const { store } = createTabHistoryStore({ wt: ['t1', 't2'] })
    store.getState().recordTabVisit('wt', 't1')
    store.getState().recordTabVisit('wt', 't2')

    store.getState().goBackTabHistory('wt')
    expect(store.getState().isNavigatingTabHistory).toBe(false)
  })
})
