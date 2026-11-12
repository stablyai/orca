import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWorkspace } from '../../../../../../shared/browser-workspace-types'

type State = {
  activeWorktreeId: string | null
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
  asleepBrowserWorktreeIds: Record<string, number>
  browserPagesByWorkspace: Record<string, never[]>
  activeBrowserTabIdByWorktree: Record<string, string>
}

const mocks = vi.hoisted(() => {
  const listeners = new Set<(state: State) => void>()
  const initial: State = {
    activeWorktreeId: null,
    browserTabsByWorktree: {},
    asleepBrowserWorktreeIds: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {}
  }
  const store = {
    state: initial,
    getState: (): State => store.state,
    setState: (change: (state: State) => Partial<State>): void => {
      store.state = { ...store.state, ...change(store.state) }
      for (const listener of listeners) {
        listener(store.state)
      }
    },
    subscribe: (listener: (state: State) => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const evicted: string[] = []
  return { store, evicted }
})
vi.mock('@/store', () => ({ useAppStore: mocks.store }))
vi.mock('@/store/slices/browser/cleanup/browser-webview-cleanup', () => ({
  destroyWorktreeBrowserGuests: (_tabs: unknown, _pages: unknown, worktreeId: string) =>
    mocks.evicted.push(worktreeId)
}))

const { sleepWorktreeBrowserTabs, installBrowserTabWakeOnOpen, selectAwakeBrowserTabsByWorktree } =
  await import('./browser-tab-sleep')
const { isInactiveWorkspace } = await import('@/lib/workspace/activity/worktree-activity-state')

const tab = (id: string): BrowserWorkspace => ({
  id,
  worktreeId: 'wt',
  url: `http://localhost:3000/${id}`,
  title: id,
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 1
})

const state = (): State => mocks.store.getState()
const inactive = (): boolean =>
  isInactiveWorkspace('wt', {}, {}, selectAwakeBrowserTabsByWorktree(state()), new Set())

beforeEach(() => {
  mocks.evicted.length = 0
  mocks.store.state = {
    activeWorktreeId: null,
    browserTabsByWorktree: { wt: [tab('a'), tab('b'), tab('c')] },
    asleepBrowserWorktreeIds: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: { wt: 'b' }
  }
})

describe('sleep keeps browser tabs in place (NEW-01)', () => {
  it('keeps every tab, in order, with the same active tab; drops only their pages', () => {
    const before = state().browserTabsByWorktree
    sleepWorktreeBrowserTabs('wt', 42)
    expect(mocks.evicted).toEqual(['wt'])
    // The layout itself is untouched: same object, same order, same active tab.
    expect(state().browserTabsByWorktree).toBe(before)
    expect(state().browserTabsByWorktree.wt.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(state().activeBrowserTabIdByWorktree.wt).toBe('b')
  })

  it('asleep tabs are not activity, so the workspace still reads as asleep', () => {
    expect(inactive()).toBe(false)
    sleepWorktreeBrowserTabs('wt', 42)
    expect(inactive()).toBe(true)
  })

  it('opening the workspace again wakes its tabs', () => {
    const stop = installBrowserTabWakeOnOpen()
    sleepWorktreeBrowserTabs('wt', 42)
    mocks.store.setState(() => ({ activeWorktreeId: 'wt' }))
    expect(state().asleepBrowserWorktreeIds).toEqual({})
    expect(inactive()).toBe(false)
    expect(state().browserTabsByWorktree.wt.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    stop()
  })
})
