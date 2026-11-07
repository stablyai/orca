// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UnreadBadgeCountModule from '@/lib/unread-badge-count'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { makeTab } from '../store/slices/store-session-test-harness'

const { getUnreadBadgeCount } = vi.hoisted(() => ({ getUnreadBadgeCount: vi.fn() }))

vi.mock('@/lib/unread-badge-count', async (importOriginal) => {
  const actual = await importOriginal<typeof UnreadBadgeCountModule>()
  getUnreadBadgeCount.mockImplementation(actual.getUnreadBadgeCount)
  return { ...actual, getUnreadBadgeCount }
})

import { useAppStore } from '@/store'
import { useUnreadDockBadge } from './useUnreadDockBadge'

const initialState = useAppStore.getInitialState()

describe('useUnreadDockBadge', () => {
  let setUnreadDockBadgeCount: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getUnreadBadgeCount.mockClear()
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

  it('does not rescan workspaces for unrelated remote activity or parent renders', () => {
    const worktrees = Array.from({ length: 100 }, (_, index) =>
      makeWorktree({ id: `repo::worktree-${index}`, repoId: 'repo', isUnread: index === 99 })
    )
    useAppStore.setState({ worktreesByRepo: { repo: worktrees } })
    const hook = renderHook(() => useUnreadDockBadge(false))

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

  // Count renders because this App-root subscription can rerender the entire shell for an unchanged badge.
  it('leaves the App root asleep through title frames and wakes it only on a badge change', () => {
    const worktrees = Array.from({ length: 20 }, (_, index) =>
      makeWorktree({ id: `repo::worktree-${index}`, repoId: 'repo', isUnread: index === 19 })
    )
    const tabsByWorktree = Object.fromEntries(
      worktrees.map((worktree, index) => [
        worktree.id,
        [makeTab({ id: `tab-${index}`, worktreeId: worktree.id })]
      ])
    )
    useAppStore.setState({ worktreesByRepo: { repo: worktrees }, tabsByWorktree })
    let renders = 0
    renderHook(() => {
      renders += 1
      return useUnreadDockBadge(false)
    })
    const rendersAfterMount = renders

    // Separate acts: title frames arrive as individual store writes, not one batch.
    for (let index = 0; index < 20; index += 1) {
      act(() => useAppStore.getState().updateTabTitle(`tab-${index}`, `agent frame ${index}`))
    }

    expect(useAppStore.getState().tabsByWorktree).not.toBe(tabsByWorktree)
    expect(renders).toBe(rendersAfterMount)

    act(() =>
      useAppStore.getState().markAgentAttentionUnread({
        workspaceId: 'repo::worktree-0',
        subjectKey: null,
        groupId: null,
        reason: 'agent-completion'
      })
    )
    expect(renders).toBe(rendersAfterMount + 1)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(2)

    act(() =>
      useAppStore
        .getState()
        .readOnScreenAttention(
          { workspaceIds: ['repo::worktree-0'], targets: [] },
          { screenArrived: true }
        )
    )
    expect(renders).toBe(rendersAfterMount + 2)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(1)
  })

  it('keeps the root asleep through folder title frames and unrelated attention writes', () => {
    const folder = makeFolderWorkspace({ id: 'bell-folder', isUnread: true })
    const key = `folder:${folder.id}`
    const tab = makeTab({ id: 'folder-bell', worktreeId: key })
    useAppStore.setState({
      projectGroups: [
        {
          id: folder.projectGroupId,
          name: 'folder-group',
          parentPath: '/work',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 0,
          updatedAt: 0
        }
      ],
      folderWorkspaces: [folder],
      tabsByWorktree: { [key]: [tab] },
      unreadTerminalTabs: { [tab.id]: 'terminal-bell' }
    })
    let renders = 0
    renderHook(() => {
      renders += 1
      return useUnreadDockBadge(false)
    })
    const initialRenders = renders
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(1)
    for (let index = 0; index < 20; index += 1) {
      act(() => useAppStore.getState().updateTabTitle(tab.id, `folder frame ${index}`))
    }
    act(() =>
      useAppStore.setState({
        unreadTerminalTabs: {
          ...useAppStore.getState().unreadTerminalTabs,
          orphan: 'terminal-bell'
        }
      })
    )
    expect(renders).toBe(initialRenders)
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(1)
    act(() => useAppStore.setState({ unreadTerminalTabs: { orphan: 'terminal-bell' } }))
    expect(renders).toBe(initialRenders + 1)
    expect(setUnreadDockBadgeCount).toHaveBeenLastCalledWith(0)
  })
})
