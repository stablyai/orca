// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UnreadBadgeCountModule from '@/lib/unread-badge-count'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import { resetFloatingWorkspaceUnreadSelectorCacheForTest } from '@/store/selectors'
import {
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree
} from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'

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
    resetFloatingWorkspaceUnreadSelectorCacheForTest()
    useAppStore.setState(
      {
        ...initialState,
        worktreesByRepo: {},
        folderWorkspaces: [],
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

  it('recounts only when a workspace flag moves', () => {
    const worktree = makeWorktree({ id: 'repo::unread', repoId: 'repo' })
    const tab = makeTab({ id: 'tab-unread', worktreeId: worktree.id })
    renderHook(() => useUnreadDockBadge())
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(0)

    act(() => useAppStore.setState({ worktreesByRepo: { repo: [worktree] } }))
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(2)
    act(() => useAppStore.setState({ tabsByWorktree: { [worktree.id]: [tab] } }))
    act(() => useAppStore.setState({ unreadTerminalTabs: { [tab.id]: 'terminal-bell' } }))
    // A tab marker without its workspace flag neither counts nor recounts.
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(2)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(0)

    act(() => useAppStore.getState().markWorktreeUnread(worktree.id))
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(3)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(1)

    act(() =>
      useAppStore.setState({
        folderWorkspaces: [makeFolderWorkspace({ id: 'folder-1', isUnread: true })]
      })
    )
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(2)

    act(() => {
      useAppStore.getState().clearWorktreeUnread(worktree.id)
      useAppStore.setState({ folderWorkspaces: [makeFolderWorkspace({ id: 'folder-1' })] })
    })
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(0)
    expect(useAppStore.getState().unreadTerminalTabs).toEqual({ [tab.id]: 'terminal-bell' })
  })

  it('follows floating unread while the floating terminal is enabled', () => {
    const floatingTab = makeTab({ id: 'floating-tab', worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home'), floatingTerminalEnabled: true },
      tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] },
      unreadTerminalTabs: { [floatingTab.id]: 'terminal-bell' }
    })
    renderHook(() => useUnreadDockBadge())
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(1)

    const setFloatingEnabled = (floatingTerminalEnabled: boolean): void => {
      const settings = useAppStore.getState().settings
      if (settings) {
        useAppStore.setState({ settings: { ...settings, floatingTerminalEnabled } })
      }
    }
    act(() => setFloatingEnabled(false))
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(0)
    act(() => setFloatingEnabled(true))
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(1)

    act(() => useAppStore.getState().clearTerminalTabUnread(floatingTab.id))
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(0)
  })

  it('neither recounts nor re-renders through a floating title storm', () => {
    const floatingTabs = [0, 1].map((index) =>
      makeTab({ id: `floating-${index}`, worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    )
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home'), floatingTerminalEnabled: true },
      tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: floatingTabs },
      unreadTerminalTabs: { 'floating-0': 'terminal-bell', 'floating-1': 'terminal-bell' }
    })
    let renders = 0
    renderHook(() => {
      renders += 1
      return useUnreadDockBadge()
    })
    const rendersAfterMount = renders
    const badgeWritesAfterMount = setUnreadDockBadgeCount.mock.calls.length
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(1)

    for (let index = 0; index < 10; index += 1) {
      act(() => useAppStore.getState().updateTabTitle(`floating-${index % 2}`, `frame ${index}`))
    }

    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(1)
    expect(renders).toBe(rendersAfterMount)
    expect(setUnreadDockBadgeCount).toHaveBeenCalledTimes(badgeWritesAfterMount)
  })

  // Why render-counted: this hook is mounted on the App root, so anything that wakes its
  // subscription re-renders the whole shell — the chrome layout, both providers and every
  // non-memoised overlay — for a badge integer that did not move.
  it('leaves the App root asleep through title and activation storms', () => {
    const worktrees = Array.from({ length: 20 }, (_, index) =>
      makeWorktree({ id: `repo::worktree-${index}`, repoId: 'repo', isUnread: index === 19 })
    )
    const tabsByWorktree = Object.fromEntries(
      worktrees.map((worktree, index) => [
        worktree.id,
        [makeTab({ id: `tab-${index}`, worktreeId: worktree.id })]
      ])
    )
    const unifiedTabsByWorktree = Object.fromEntries(
      worktrees.map((worktree, index) => [
        worktree.id,
        [makeUnifiedTab({ id: `tab-${index}`, worktreeId: worktree.id, groupId: `g-${index}` })]
      ])
    )
    const groupsByWorktree = Object.fromEntries(
      worktrees.map((worktree, index) => [
        worktree.id,
        [makeTabGroup({ id: `g-${index}`, worktreeId: worktree.id, tabOrder: [`tab-${index}`] })]
      ])
    )
    useAppStore.setState({
      worktreesByRepo: { repo: worktrees },
      tabsByWorktree,
      unifiedTabsByWorktree,
      groupsByWorktree,
      unreadTerminalTabs: { 'tab-19': 'terminal-bell' }
    })
    let renders = 0
    renderHook(() => {
      renders += 1
      return useUnreadDockBadge()
    })
    const rendersAfterMount = renders
    const badgeWritesAfterMount = setUnreadDockBadgeCount.mock.calls.length
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(1)

    // Separate acts: title frames and activations arrive as individual store writes, not one batch.
    for (let index = 0; index < 20; index += 1) {
      act(() => useAppStore.getState().updateTabTitle(`tab-${index}`, `agent frame ${index}`))
      act(() => useAppStore.getState().activateTab(`tab-${index}`))
      act(() => useAppStore.getState().bumpWorktreeActivity(`repo::worktree-${index}`))
    }

    expect(useAppStore.getState().tabsByWorktree).not.toBe(tabsByWorktree)
    expect(useAppStore.getState().unifiedTabsByWorktree).not.toBe(unifiedTabsByWorktree)
    expect(renders).toBe(rendersAfterMount)
    expect(setUnreadDockBadgeCount).toHaveBeenCalledTimes(badgeWritesAfterMount)

    // A workspace becomes unread.
    act(() => useAppStore.getState().markWorktreeUnread('repo::worktree-0'))
    expect(renders).toBe(rendersAfterMount + 1)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(2)

    // A workspace is read.
    act(() => useAppStore.getState().clearWorktreeUnread('repo::worktree-19'))
    expect(renders).toBe(rendersAfterMount + 2)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(1)

    act(() => useAppStore.getState().clearWorktreeUnread('repo::worktree-0'))
    expect(renders).toBe(rendersAfterMount + 3)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(0)
  })
})
