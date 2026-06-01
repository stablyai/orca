/* eslint-disable max-lines -- Why: dispatch guards are interdependent, so these notification liveness and unread regressions stay together with one store mock. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'

type MockState = {
  activeWorktreeId: string | null
  tabsByWorktree: Record<string, { id: string; ptyId?: string | null }[]>
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, boolean>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  browserTabsByWorktree: Record<string, unknown[]>
  retainedAgentsByPaneKey: Record<string, { worktreeId: string }>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  worktreesByRepo: Record<
    string,
    {
      id: string
      repoId: string
      displayName?: string
      branch?: string
      workspaceStatus?: string
    }[]
  >
  repos: { id: string; displayName?: string; connectionId?: string | null }[]
  settings: {
    experimentalTerminalAttention?: boolean
    notifications?: {
      customSoundPath?: string | null
      customSoundId?: string | null
    }
  }
  markWorktreeUnread: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
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

function makeAgentStatus(paneKey: string): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'codex-hook-notify',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    agentType: 'codex',
    paneKey,
    terminalTitle: 'codex',
    stateHistory: [],
    lastAssistantMessage: 'Done.'
  }
}

function stubDocumentFocus({
  visibilityState,
  focused
}: {
  visibilityState: DocumentVisibilityState
  focused: boolean
}): void {
  vi.stubGlobal('document', {
    visibilityState,
    hasFocus: vi.fn(() => focused)
  })
}

describe('dispatchTerminalNotification', () => {
  const liveLeafId = '11111111-1111-4111-8111-111111111111'
  const staleLeafId = '22222222-2222-4222-8222-222222222222'
  const paneKey = `tab-1:${liveLeafId}`
  const stalePaneKey = `tab-1:${staleLeafId}`

  beforeEach(() => {
    vi.clearAllMocks()
    mockState = {
      activeWorktreeId: 'wt-secondary',
      tabsByWorktree: {
        'wt-primary': [{ id: 'tab-1', ptyId: 'pty-1' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      suppressedPtyExitIds: {},
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: liveLeafId },
          activeLeafId: liveLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [liveLeafId]: 'pty-1' }
        }
      },
      browserTabsByWorktree: {},
      retainedAgentsByPaneKey: {},
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatus(paneKey)
      },
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-primary',
            repoId: 'repo1',
            displayName: 'master',
            branch: 'master'
          },
          {
            id: 'wt-secondary',
            repoId: 'repo1',
            displayName: 'e2e-secondary',
            branch: 'e2e-secondary'
          }
        ]
      },
      repos: [{ id: 'repo1', displayName: 'orca', connectionId: null }],
      settings: { experimentalTerminalAttention: true, notifications: { customSoundPath: null } },
      markWorktreeUnread: vi.fn(),
      markTerminalTabUnread: vi.fn(),
      markTerminalPaneUnread: vi.fn()
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

  it('uses a live pane key when marking inactive worktree attention', () => {
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey,
        repoLabel: 'orca',
        worktreeLabel: 'master',
        terminalTitle: 'codex',
        isActiveWorktree: false,
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'codex-hook-notify',
        agentLastAssistantMessage: 'Done.'
      })
    )
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('uses a live pane key when inactive worktree tab membership is not hydrated', () => {
    mockState.tabsByWorktree = {}

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey
      })
    )
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('uses tab liveness when the layout has the leaf but no leaf pty binding yet', () => {
    mockState.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = {}

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey
      })
    )
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('falls back to background-worktree unread when terminal attention is disabled', () => {
    mockState.settings.experimentalTerminalAttention = false

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('does not mark the visible focused worktree unread when terminal attention is disabled', () => {
    mockState.settings.experimentalTerminalAttention = false
    mockState.activeWorktreeId = 'wt-primary'
    stubDocumentFocus({ visibilityState: 'visible', focused: true })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('marks the selected worktree unread when the app is not focused', () => {
    mockState.settings.experimentalTerminalAttention = false
    mockState.activeWorktreeId = 'wt-primary'
    stubDocumentFocus({ visibilityState: 'visible', focused: false })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('drops a pane key when its tab is hydrated under another worktree', () => {
    mockState.tabsByWorktree = {
      'wt-secondary': [{ id: 'tab-1' }]
    }

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('does not mark unread for a stale closed pane key when another pty in the tab is live', () => {
    mockState.agentStatusByPaneKey[stalePaneKey] = makeAgentStatus(stalePaneKey)

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: stalePaneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('uses a fresh hook snapshot when inactive PTY liveness has not caught up', () => {
    mockState.ptyIdsByTabId = {}

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey,
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'codex-hook-notify',
        agentLastAssistantMessage: 'Done.'
      })
    )
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('uses the accepted hook snapshot when the live store row is gone before dispatch', () => {
    mockState.ptyIdsByTabId = {}
    mockState.agentStatusByPaneKey = {}

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey,
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'codex-hook-notify',
        agentType: 'codex',
        lastAssistantMessage: 'Done.'
      }
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-primary',
        paneKey,
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'codex-hook-notify',
        agentLastAssistantMessage: 'Done.'
      })
    )
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('drops accepted hook snapshots for an intentionally suppressed pty', () => {
    mockState.ptyIdsByTabId = {}
    mockState.agentStatusByPaneKey = {}
    mockState.suppressedPtyExitIds = { 'pty-1': true }

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey,
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'codex-hook-notify',
        agentType: 'codex',
        lastAssistantMessage: 'Done.'
      }
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('still drops stale notifications when neither pty liveness nor fresh hook status exists', () => {
    mockState.ptyIdsByTabId = {}
    mockState.agentStatusByPaneKey[paneKey] = {
      ...makeAgentStatus(paneKey),
      updatedAt: Date.now() - 11_000
    }

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })
})
