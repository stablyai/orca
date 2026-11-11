import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWorkspace } from '../../../../../../shared/browser-workspace-types'

type State = {
  activeWorktreeId: string | null
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
  browserPagesByWorkspace: Record<string, unknown[]>
  activeBrowserTabIdByWorktree: Record<string, string>
}

const mocks = vi.hoisted(() => {
  const listeners = new Set<(state: unknown) => void>()
  const store = {
    state: {} as Record<string, unknown>,
    getState: () => store.state,
    setState: (change: (state: Record<string, unknown>) => Record<string, unknown>) => {
      store.state = { ...store.state, ...change(store.state) }
      for (const listener of listeners) {
        listener(store.state)
      }
    },
    subscribe: (listener: (state: unknown) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return { store, evicted: [] as string[] }
})
vi.mock('@/store', () => ({ useAppStore: mocks.store }))
vi.mock('@/store/slices/browser/cleanup/browser-webview-cleanup', () => ({
  destroyWorktreeBrowserGuests: (_tabs: unknown, _pages: unknown, worktreeId: string) =>
    mocks.evicted.push(worktreeId)
}))

const { sleepWorktreeBrowserTabs, installBrowserTabWakeOnOpen } = await import(
  './browser-tab-sleep'
)
const { isInactiveWorkspace } = await import('@/lib/worktree-activity-state')

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

const state = (): State => mocks.store.getState() as unknown as State

beforeEach(() => {
  mocks.evicted.length = 0
  mocks.store.state = {
    activeWorktreeId: null,
    browserTabsByWorktree: { wt: [tab('a'), tab('b'), tab('c')] },
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: { wt: 'b' }
  }
})

describe('sleep keeps browser tabs in place (NEW-01)', () => {
  it('keeps every tab, in order, with the same active tab; drops only their pages', () => {
    sleepWorktreeBrowserTabs('wt', 42)
    expect(mocks.evicted).toEqual(['wt'])
    expect(state().browserTabsByWorktree.wt.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(state().browserTabsByWorktree.wt.every((t) => t.sleptAt === 42)).toBe(true)
    expect(state().activeBrowserTabIdByWorktree.wt).toBe('b')
  })

  it('asleep tabs are not activity, so the workspace still reads as asleep', () => {
    const inactive = (): boolean =>
      isInactiveWorkspace('wt', {}, {}, state().browserTabsByWorktree, new Set())
    expect(inactive()).toBe(false)
    sleepWorktreeBrowserTabs('wt', 42)
    expect(inactive()).toBe(true)
  })

  it('opening the workspace again wakes its tabs, still in the same order', () => {
    const stop = installBrowserTabWakeOnOpen()
    sleepWorktreeBrowserTabs('wt', 42)
    mocks.store.setState(() => ({ activeWorktreeId: 'wt' }))
    expect(state().browserTabsByWorktree.wt.map((t) => [t.id, t.sleptAt])).toEqual([
      ['a', undefined],
      ['b', undefined],
      ['c', undefined]
    ])
    expect(state().activeBrowserTabIdByWorktree.wt).toBe('b')
    stop()
  })
})
