// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UnreadBadgeCountModule from '@/lib/unread-badge-count'
import { makeTab, makeWorktree } from '@/store/slices/store-test-helpers'

const { getUnreadBadgeCount } = vi.hoisted(() => ({ getUnreadBadgeCount: vi.fn() }))

vi.mock('@/lib/unread-badge-count', async (importOriginal) => {
  const actual = await importOriginal<typeof UnreadBadgeCountModule>()
  getUnreadBadgeCount.mockImplementation(actual.getUnreadBadgeCount)
  return { ...actual, getUnreadBadgeCount }
})

import { useAppStore } from '@/store'
import { clearUnreadDockBadgeCount, useUnreadDockBadge } from './useUnreadDockBadge'

const initialState = useAppStore.getInitialState()

describe('useUnreadDockBadge', () => {
  let setUnreadDockBadgeCount: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getUnreadBadgeCount.mockClear()
    useAppStore.setState(
      {
        ...initialState,
        worktreesByRepo: {},
        tabsByWorktree: {},
        unreadTerminalTabs: {}
      },
      true
    )
    setUnreadDockBadgeCount = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: {
        app: {
          setUnreadDockBadgeCount
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    vi.unstubAllGlobals()
  })

  it('clears the app badge', () => {
    clearUnreadDockBadgeCount()

    expect(setUnreadDockBadgeCount).toHaveBeenCalledWith(0)
  })

  it('treats badge clearing as best-effort', async () => {
    setUnreadDockBadgeCount.mockRejectedValueOnce(new Error('dock unavailable'))

    clearUnreadDockBadgeCount()
    await Promise.resolve()

    expect(setUnreadDockBadgeCount).toHaveBeenCalledWith(0)
  })

  it('no-ops when the preload API is unavailable', () => {
    vi.stubGlobal('window', {})

    expect(() => clearUnreadDockBadgeCount()).not.toThrow()
  })

  it('does not rescan workspaces for unrelated remote activity or parent renders', () => {
    const worktrees = Array.from({ length: 100 }, (_, index) =>
      makeWorktree({ id: `repo::worktree-${index}`, repoId: 'repo' })
    )
    const tabsByWorktree = Object.fromEntries(
      worktrees.map((worktree, index) => [
        worktree.id,
        [makeTab({ id: `tab-${index}`, worktreeId: worktree.id })]
      ])
    )
    useAppStore.setState({
      worktreesByRepo: { repo: worktrees },
      tabsByWorktree,
      unreadTerminalTabs: { 'tab-99': true }
    })
    const hook = renderHook(() => useUnreadDockBadge())

    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(1)
    act(() => {
      for (let index = 0; index < 100; index += 1) {
        useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
      }
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map(useAppStore.getState().runtimeStatusByEnvironmentId)
      })
    })
    hook.rerender()

    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(1)
  })

  it('recounts when worktree, tab, or unread references change', () => {
    renderHook(() => useUnreadDockBadge())
    const worktree = makeWorktree({
      id: 'repo::unread',
      repoId: 'repo'
    })
    const tab = makeTab({ id: 'tab-unread', worktreeId: worktree.id })

    act(() => useAppStore.setState({ worktreesByRepo: { repo: [worktree] } }))
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(2)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(0)

    act(() => useAppStore.setState({ tabsByWorktree: { [worktree.id]: [tab] } }))
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(3)

    act(() => useAppStore.setState({ unreadTerminalTabs: { [tab.id]: true } }))
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(4)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(1)

    act(() => useAppStore.setState({ unreadTerminalTabs: {} }))
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(5)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(0)
  })

  // Why render-counted: this hook is mounted on the App root, so anything that wakes its
  // subscription re-renders the whole shell — the chrome layout, both providers and every
  // non-memoised overlay — for a badge integer that did not move.
  it('leaves the App root asleep through title frames and wakes it only on a badge change', () => {
    const worktrees = Array.from({ length: 20 }, (_, index) =>
      makeWorktree({ id: `repo::worktree-${index}`, repoId: 'repo' })
    )
    const tabsByWorktree = Object.fromEntries(
      worktrees.map((worktree, index) => [
        worktree.id,
        [makeTab({ id: `tab-${index}`, worktreeId: worktree.id })]
      ])
    )
    useAppStore.setState({
      worktreesByRepo: { repo: worktrees },
      tabsByWorktree,
      unreadTerminalTabs: { 'tab-19': true }
    })
    let renders = 0
    renderHook(() => {
      renders += 1
      return useUnreadDockBadge()
    })
    const rendersAfterMount = renders

    // Separate acts: title frames arrive as individual store writes, not one batch.
    for (let index = 0; index < 20; index += 1) {
      act(() => useAppStore.getState().updateTabTitle(`tab-${index}`, `agent frame ${index}`))
    }

    expect(useAppStore.getState().tabsByWorktree).not.toBe(tabsByWorktree)
    expect(renders).toBe(rendersAfterMount)

    // A tab becomes unread.
    act(() => useAppStore.setState({ unreadTerminalTabs: { 'tab-19': true, 'tab-0': true } }))
    expect(renders).toBe(rendersAfterMount + 1)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(2)

    // A tab is read.
    act(() => useAppStore.setState({ unreadTerminalTabs: { 'tab-19': true } }))
    expect(renders).toBe(rendersAfterMount + 2)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(1)

    // A tab holding unread state closes.
    act(() =>
      useAppStore.setState({
        tabsByWorktree: { ...useAppStore.getState().tabsByWorktree, 'repo::worktree-19': [] },
        unreadTerminalTabs: {}
      })
    )
    expect(renders).toBe(rendersAfterMount + 3)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(0)
  })
})
