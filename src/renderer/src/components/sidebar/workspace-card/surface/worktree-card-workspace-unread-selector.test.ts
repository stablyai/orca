import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type * as SlotTargetsModule from '../../worktree-card-slot-targets'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { createWorkspaceUnreadSelector } from './worktree-card-workspace-unread-selector'

const resolve = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../worktree-card-slot-targets', async (importOriginal) => {
  const actual = await importOriginal<typeof SlotTargetsModule>()
  return {
    ...actual,
    workspaceUnreadTargetsOutsideAgentRows: (
      ...args: Parameters<typeof actual.workspaceUnreadTargetsOutsideAgentRows>
    ) => {
      resolve.calls++
      return actual.workspaceUnreadTargetsOutsideAgentRows(...args)
    }
  }
})

const MARKER = { at: 1, kind: 'agent-completion' } as never
const ENTRY = (state: string) => ({ state, worktreeId: 'x' }) as never

function baseState(): AppState {
  return {
    workspacesMarkedUnreadByUser: {},
    unreadTerminalTabs: {},
    unreadAgentCompletionPanes: { 'a1:leaf': MARKER, 'b1:leaf': MARKER },
    tabsByWorktree: {
      A: [makeTab({ id: 'a1', worktreeId: 'A', ptyId: 'pty-a1' })],
      B: [makeTab({ id: 'b1', worktreeId: 'B', ptyId: 'pty-b1' })]
    },
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {
      a1: { root: null, activeLeafId: 'leaf', expandedLeafId: null },
      b1: { root: null, activeLeafId: 'leaf', expandedLeafId: null }
    },
    ptyIdsByTabId: {},
    agentStatusByPaneKey: { 'a1:leaf': ENTRY('done'), 'b1:leaf': ENTRY('working') },
    agentStatusEpoch: 0,
    acknowledgedAgentsByPaneKey: {},
    runtimePaneTitlesByTabId: {},
    activeWorktreeId: null
  } as unknown as AppState
}

beforeEach(() => {
  resolve.calls = 0
})

describe('createWorkspaceUnreadSelector', () => {
  const worktree = makeWorktree({ id: 'A', repoId: 'r', hostId: 'local', isUnread: true })

  it('ignores agent, marker, layout and selection changes in other workspaces', () => {
    const select = createWorkspaceUnreadSelector(worktree, [])
    let state = baseState()
    expect(select(state)).toBe(true)
    expect(resolve.calls).toBe(1)

    state = {
      ...state,
      agentStatusByPaneKey: { ...state.agentStatusByPaneKey, 'b1:leaf': ENTRY('done') },
      agentStatusEpoch: 1,
      acknowledgedAgentsByPaneKey: { 'b1:leaf': 1 } as never,
      runtimePaneTitlesByTabId: { b1: 'title' } as never,
      unreadAgentCompletionPanes: { ...state.unreadAgentCompletionPanes, 'b1:other': MARKER },
      terminalLayoutsByTabId: {
        ...state.terminalLayoutsByTabId,
        b1: { root: null, activeLeafId: 'other', expandedLeafId: null }
      },
      activeWorktreeId: 'B'
    } as AppState
    expect(select(state)).toBe(true)
    expect(resolve.calls).toBe(1)
  })

  it('re-resolves when this workspace’s marker, status, or tabs change', () => {
    const select = createWorkspaceUnreadSelector(worktree, [])
    let state = baseState()
    select(state)

    state = {
      ...state,
      agentStatusByPaneKey: { ...state.agentStatusByPaneKey, 'a1:leaf': ENTRY('working') }
    } as AppState
    select(state)
    expect(resolve.calls).toBe(2)

    state = {
      ...state,
      unreadAgentCompletionPanes: { 'b1:leaf': MARKER }
    } as AppState
    select(state)
    expect(resolve.calls).toBe(3)

    state = {
      ...state,
      unreadTerminalTabs: { a1: MARKER }
    } as AppState
    select(state)
    expect(resolve.calls).toBe(4)

    state = {
      ...state,
      tabsByWorktree: { ...state.tabsByWorktree, A: [...state.tabsByWorktree.A!] }
    } as AppState
    select(state)
    expect(resolve.calls).toBe(5)
  })

  it('does no work for a card that is not unread', () => {
    const select = createWorkspaceUnreadSelector({ ...worktree, isUnread: false }, [])
    expect(select(baseState())).toBe(false)
    expect(resolve.calls).toBe(0)
  })
})
