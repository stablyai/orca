import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

type MockState = {
  activeWorktreeId: string | null
  activeTabId: string | null
  tabsByWorktree: Record<string, { id: string; ptyId?: string | null }[]>
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, boolean>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  browserTabsByWorktree: Record<string, unknown[]>
  retainedAgentsByPaneKey: Record<string, { worktreeId: string }>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  notificationsMutedByWorktree: Record<string, boolean>
  worktreesByRepo: Record<string, { id: string; repoId: string; displayName?: string }[]>
  repos: { id: string; displayName?: string; connectionId?: string | null }[]
  settings: { experimentalTerminalAttention?: boolean }
  markWorktreeUnread: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  markAgentCompletionPaneUnread: ReturnType<typeof vi.fn>
}

const playDesktopNotificationSound = vi.hoisted(() => vi.fn())
let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockState
  }
}))

vi.mock('@/lib/desktop-notification-sound', () => ({
  playDesktopNotificationSound
}))

describe('dispatchTerminalNotification per-worktree mute', () => {
  const leafId = '11111111-1111-4111-8111-111111111111'
  const paneKey = `tab-1:${leafId}`

  beforeEach(() => {
    vi.clearAllMocks()
    const now = Date.now()
    mockState = {
      activeWorktreeId: 'wt-secondary',
      activeTabId: 'tab-1',
      tabsByWorktree: { 'wt-primary': [{ id: 'tab-1', ptyId: 'pty-1' }] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      suppressedPtyExitIds: {},
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      },
      browserTabsByWorktree: {},
      retainedAgentsByPaneKey: {},
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'done',
          prompt: 'codex-hook-notify',
          updatedAt: now,
          stateStartedAt: now,
          agentType: 'codex',
          paneKey,
          terminalTitle: 'codex',
          stateHistory: [],
          lastAssistantMessage: 'Done.'
        }
      },
      notificationsMutedByWorktree: {},
      worktreesByRepo: {
        repo1: [
          { id: 'wt-primary', repoId: 'repo1', displayName: 'master' },
          { id: 'wt-secondary', repoId: 'repo1', displayName: 'e2e-secondary' }
        ]
      },
      repos: [{ id: 'repo1', displayName: 'orca', connectionId: null }],
      settings: { experimentalTerminalAttention: true },
      markWorktreeUnread: vi.fn(),
      markTerminalTabUnread: vi.fn(),
      markTerminalPaneUnread: vi.fn(),
      markAgentCompletionPaneUnread: vi.fn()
    }
    vi.stubGlobal('window', {
      api: {
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true })
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps unread marking but skips OS dispatch for a muted worktree', () => {
    mockState.notificationsMutedByWorktree = { 'wt-primary': true }

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'agent-completion')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey, 'agent-completion')
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(playDesktopNotificationSound).not.toHaveBeenCalled()
  })

  it('mutes terminal-bell notifications for a muted worktree', () => {
    mockState.notificationsMutedByWorktree = { 'wt-primary': true }

    dispatchTerminalNotification('wt-primary', {
      source: 'terminal-bell',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
  })

  it('does not mute other worktrees when one worktree is muted', () => {
    mockState.notificationsMutedByWorktree = { 'wt-secondary': true }

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
  })
})
