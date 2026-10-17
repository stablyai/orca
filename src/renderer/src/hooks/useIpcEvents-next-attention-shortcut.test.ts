import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  orderedWorkspaces: vi.fn(),
  activateAndRevealWorkspace: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  activateStructuredAgentSessionTab: vi.fn(),
  activateTerminalTabOnOwner: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { info: mocks.toastInfo } }))
vi.mock('@/components/sidebar/attention-order-workspaces', () => ({
  getAttentionOrderWorkspaceTargets: mocks.orderedWorkspaces
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionTab: mocks.activateStructuredAgentSessionTab
}))
vi.mock('@/lib/terminal-tab-owner-activation', () => ({
  activateTerminalTabOnOwner: mocks.activateTerminalTabOnOwner
}))

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { jumpToNextAttentionFromShortcut } from './ipc-events/next-attention-command'

const NOW = new Date('2026-03-27T12:00:00.000Z').getTime()
const LEAF = '11111111-1111-4111-8111-111111111111'
const initialState = useAppStore.getInitialState()
const activateTab = vi.fn()

function terminalTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: 'pty',
    worktreeId,
    title: 'bash',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function layout(): TerminalLayoutSnapshot {
  return { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
}

function seed(overrides: Partial<AppState>): AppState {
  useAppStore.setState({ ...initialState, activateTab, ...overrides }, true)
  return useAppStore.getState()
}

describe('jumpToNextAttentionFromShortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.orderedWorkspaces.mockReturnValue([
      { id: 'a', identityHostId: 'local', isUnread: false, lastActivityAt: 0 }
    ])
    mocks.activateAndRevealWorkspace.mockReturnValue({})
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('shows a toast and stays put when nothing needs attention', () => {
    jumpToNextAttentionFromShortcut(seed({}), NOW)

    expect(mocks.toastInfo).toHaveBeenCalledWith('No workspaces need attention', {
      id: 'next-attention-none'
    })
    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
  })

  it('opens the workspace, the exact split copy and the pane of a terminal target', () => {
    const state = seed({
      tabsByWorktree: { a: [terminalTab('t1', 'a')] },
      terminalLayoutsByTabId: { t1: layout() },
      unifiedTabsByWorktree: {
        a: [
          {
            id: 'u1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'a',
            contentType: 'terminal',
            label: 't1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      groupsByWorktree: { a: [{ id: 'g1', worktreeId: 'a', activeTabId: 'u1', tabOrder: ['u1'] }] },
      unreadAgentCompletionPanes: { [`t1:${LEAF}`]: 'agent-completion' }
    })

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('a', {
      navigationIntent: 'user-open'
    })
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('t1', LEAF)
    expect(activateTab).toHaveBeenCalledWith('u1', { worktreeId: 'a' })
    expect(mocks.activateTerminalTabOnOwner).toHaveBeenCalledWith('a', 't1', LEAF)
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('activates a tab-only terminal target without a pane to focus', () => {
    const state = seed({
      tabsByWorktree: { a: [terminalTab('t1', 'a')] },
      unreadTerminalTabs: { t1: 'terminal-bell' }
    })

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('t1', null)
    expect(mocks.activateTerminalTabOnOwner).toHaveBeenCalledWith('a', 't1', null)
  })

  it('opens a native chat target through the structured session activation', () => {
    const chat: Tab = {
      id: 'chat-1',
      entityId: 'session-1',
      groupId: 'g1',
      worktreeId: 'a',
      contentType: 'agent-session',
      label: 'chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    const state = seed({
      unifiedTabsByWorktree: { a: [chat] },
      groupsByWorktree: {
        a: [{ id: 'g1', worktreeId: 'a', activeTabId: 'chat-1', tabOrder: ['chat-1'] }]
      },
      unreadAgentCompletionPanes: {
        [structuredAgentSessionPaneKey('chat-1', 'session-1')]: 'agent-completion'
      }
    })

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateStructuredAgentSessionTab).toHaveBeenCalledWith({
      worktreeId: 'a',
      tabId: 'chat-1'
    })
    expect(mocks.activateTerminalTabOnOwner).not.toHaveBeenCalled()
  })

  it('opens only the workspace for a manual unread flag', () => {
    mocks.orderedWorkspaces.mockReturnValue([
      { id: 'a', identityHostId: 'local', isUnread: true, lastActivityAt: 0 }
    ])
    const state = seed({})

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(mocks.activateTerminalTabOnOwner).not.toHaveBeenCalled()
  })

  it('asks the owner to show a pane this renderer has not mirrored yet', () => {
    const paneKey = `remote-tab:${LEAF}`
    const state = seed({
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'waiting',
          prompt: '',
          updatedAt: NOW - 1000,
          stateStartedAt: NOW - 1000,
          agentType: 'codex',
          paneKey,
          worktreeId: 'a',
          stateHistory: []
        }
      }
    })

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateTerminalTabOnOwner).toHaveBeenCalledWith('a', 'remote-tab', LEAF)
  })

  it('stops quietly when the workspace cannot be activated', () => {
    mocks.activateAndRevealWorkspace.mockReturnValue(false)
    const state = seed({
      tabsByWorktree: { a: [terminalTab('t1', 'a')] },
      unreadTerminalTabs: { t1: 'terminal-bell' }
    })

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('stops quietly when the target tab closed before activation', () => {
    const state = seed({
      tabsByWorktree: { a: [terminalTab('t1', 'a')] },
      unreadTerminalTabs: { t1: 'terminal-bell' }
    })
    mocks.activateAndRevealWorkspace.mockImplementation(() => {
      useAppStore.setState({ tabsByWorktree: { a: [] } })
      return {}
    })

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('walks on to the next target when one cannot be reached', () => {
    mocks.orderedWorkspaces.mockReturnValue([
      { id: 'a', identityHostId: 'local', isUnread: false, lastActivityAt: 0 },
      { id: 'b', identityHostId: 'local', isUnread: false, lastActivityAt: 0 }
    ])
    mocks.activateAndRevealWorkspace.mockImplementation((id: string) => (id === 'a' ? false : {}))
    const state = seed({
      tabsByWorktree: { a: [terminalTab('ta', 'a')], b: [terminalTab('tb', 'b')] },
      unreadTerminalTabs: { ta: 'terminal-bell', tb: 'terminal-bell' }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateAndRevealWorkspace).toHaveBeenLastCalledWith('b', expect.anything())
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tb', null)
    warn.mockRestore()
  })

  it('tries an unreachable workspace once even when it holds several targets', () => {
    mocks.orderedWorkspaces.mockReturnValue([
      { id: 'a', identityHostId: 'local', isUnread: false, lastActivityAt: 0 },
      { id: 'b', identityHostId: 'local', isUnread: false, lastActivityAt: 0 }
    ])
    mocks.activateAndRevealWorkspace.mockImplementation((id: string) => (id === 'a' ? false : {}))
    const state = seed({
      tabsByWorktree: {
        a: [terminalTab('ta1', 'a'), terminalTab('ta2', 'a')],
        b: [terminalTab('tb', 'b')]
      },
      unreadTerminalTabs: { ta1: 'terminal-bell', ta2: 'terminal-bell', tb: 'terminal-bell' }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateAndRevealWorkspace.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    warn.mockRestore()
  })

  it('does nothing while the Cmd+J palette is open', () => {
    const state = seed({
      activeModal: 'worktree-palette',
      tabsByWorktree: { a: [terminalTab('t1', 'a')] },
      unreadTerminalTabs: { t1: 'terminal-bell' }
    })

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('goes to the topmost target from Settings even when it is the active workspace', () => {
    const state = seed({
      activeView: 'settings',
      activeWorktreeId: 'a',
      activeTabType: 'terminal',
      activeTabId: 'ta',
      tabsByWorktree: { a: [terminalTab('ta', 'a'), terminalTab('tb', 'a')] },
      terminalLayoutsByTabId: { ta: layout(), tb: layout() },
      unreadTerminalPanes: { [`ta:${LEAF}`]: 'terminal-bell', [`tb:${LEAF}`]: 'terminal-bell' }
    })

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('ta', LEAF)
  })

  it('steps past the place the user is already at', () => {
    mocks.orderedWorkspaces.mockReturnValue([
      { id: 'a', identityHostId: 'local', isUnread: false, lastActivityAt: 0 },
      { id: 'b', identityHostId: 'local', isUnread: false, lastActivityAt: 0 }
    ])
    const state = seed({
      activeWorktreeId: 'a',
      activeWorkspaceExecutionHostId: null,
      activeTabType: 'terminal',
      activeTabId: 'ta',
      tabsByWorktree: { a: [terminalTab('ta', 'a')], b: [terminalTab('tb', 'b')] },
      terminalLayoutsByTabId: { ta: layout(), tb: layout() },
      unreadTerminalPanes: { [`ta:${LEAF}`]: 'terminal-bell', [`tb:${LEAF}`]: 'terminal-bell' }
    })

    jumpToNextAttentionFromShortcut(state, NOW)

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('b', expect.anything())
  })
})
