import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  activateAndRevealWorkspace: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  requestTerminalTabRenameWhenMounted: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

vi.mock('./workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))

vi.mock('../components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/components/tab-bar/terminal-tabs/terminal-tab-rename-request', () => ({
  requestTerminalTabRenameWhenMounted: mocks.requestTerminalTabRenameWhenMounted
}))

import { activateNativeChatAgentLaunchTab } from './activate-native-chat-agent-launch-tab'

function stateFor(
  tab: {
    id: string
    entityId: string
    worktreeId: string
    groupId: string
    contentType: string
    executionHostId?: string
  },
  activeWorktreeId: string
) {
  return {
    activeWorktreeId,
    getTab: vi.fn(() => tab),
    focusGroup: vi.fn(),
    activateTab: vi.fn(),
    setActiveTabType: vi.fn()
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('activateNativeChatAgentLaunchTab', () => {
  it('switches to a structured chat in a background workspace before renaming it', () => {
    const state = stateFor(
      {
        id: 'chat-1',
        entityId: 'session-1',
        worktreeId: 'worktree-1',
        groupId: 'group-1',
        contentType: 'agent-session',
        executionHostId: 'local'
      },
      'worktree-2'
    )
    mocks.getState.mockReturnValue(state)
    mocks.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: null })

    activateNativeChatAgentLaunchTab('chat-1')

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledExactlyOnceWith('worktree-1', {
      providesInitialSurface: true,
      revealInSidebar: false,
      clearSidebarFilters: false,
      executionHostId: 'local'
    })
    expect(state.focusGroup).toHaveBeenCalledExactlyOnceWith('worktree-1', 'group-1')
    expect(state.activateTab).toHaveBeenCalledExactlyOnceWith('chat-1', {
      worktreeId: 'worktree-1'
    })
    expect(state.setActiveTabType).toHaveBeenCalledExactlyOnceWith('agent-session', 'worktree-1')
    expect(mocks.requestTerminalTabRenameWhenMounted).toHaveBeenCalledExactlyOnceWith('chat-1')
  })

  it('activates a terminal tab in the current workspace and focuses its surface', () => {
    const state = stateFor(
      {
        id: 'terminal-tab-1',
        entityId: 'terminal-1',
        worktreeId: 'worktree-1',
        groupId: 'group-1',
        contentType: 'terminal'
      },
      'worktree-1'
    )
    mocks.getState.mockReturnValue(state)

    activateNativeChatAgentLaunchTab('terminal-tab-1')

    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(state.focusGroup).toHaveBeenCalledExactlyOnceWith('worktree-1', 'group-1')
    expect(state.activateTab).toHaveBeenCalledExactlyOnceWith('terminal-tab-1', {
      worktreeId: 'worktree-1'
    })
    expect(state.setActiveTabType).toHaveBeenCalledExactlyOnceWith('terminal', 'worktree-1')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledExactlyOnceWith('terminal-1')
    expect(mocks.requestTerminalTabRenameWhenMounted).toHaveBeenCalledExactlyOnceWith(
      'terminal-tab-1'
    )
  })

  it('does not rename when the workspace cannot be activated', () => {
    const state = stateFor(
      {
        id: 'chat-1',
        entityId: 'session-1',
        worktreeId: 'worktree-1',
        groupId: 'group-1',
        contentType: 'agent-session'
      },
      'worktree-2'
    )
    mocks.getState.mockReturnValue(state)
    mocks.activateAndRevealWorkspace.mockReturnValue(false)

    activateNativeChatAgentLaunchTab('chat-1')

    expect(state.activateTab).not.toHaveBeenCalled()
    expect(mocks.requestTerminalTabRenameWhenMounted).not.toHaveBeenCalled()
  })
})
