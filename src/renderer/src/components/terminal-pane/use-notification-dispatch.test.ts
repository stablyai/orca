/* eslint-disable max-lines -- Why: dispatch guards are interdependent, so these notification liveness and unread regressions stay together with one store mock. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'

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

function makeAgentStatus(
  paneKey: string,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  const now = Date.now()
  return {
    state: 'done',
    prompt: 'codex-hook-notify',
    updatedAt: now,
    stateStartedAt: now,
    agentType: 'codex',
    paneKey,
    terminalTitle: 'codex',
    stateHistory: [],
    lastAssistantMessage: 'Done.',
    ...overrides
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
      activeTabId: 'tab-1',
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

  it('uses a live pane key when marking inactive worktree attention', () => {
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        notificationId: buildAgentNotificationId({
          worktreeId: 'wt-primary',
          paneKey,
          stateStartedAt: mockState.agentStatusByPaneKey[paneKey].stateStartedAt
        }),
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
    expect(mockState.markAgentCompletionPaneUnread).toHaveBeenCalledWith(paneKey)
  })

  it('can mark terminal attention without dispatching an OS notification', () => {
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey,
      suppressOsNotification: true
    })

    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
  })

  it('does not mark the visible focused pane unread', () => {
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
    expect(mockState.markAgentCompletionPaneUnread).not.toHaveBeenCalled()
  })

  it('marks a hidden tab in the focused worktree unread', () => {
    const hiddenLeafId = '33333333-3333-4333-8333-333333333333'
    const hiddenPaneKey = `tab-2:${hiddenLeafId}`
    mockState.activeWorktreeId = 'wt-primary'
    mockState.activeTabId = 'tab-1'
    mockState.tabsByWorktree['wt-primary'].push({ id: 'tab-2', ptyId: 'pty-2' })
    mockState.ptyIdsByTabId['tab-2'] = ['pty-2']
    mockState.terminalLayoutsByTabId['tab-2'] = {
      root: { type: 'leaf', leafId: hiddenLeafId },
      activeLeafId: hiddenLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [hiddenLeafId]: 'pty-2' }
    }
    mockState.agentStatusByPaneKey[hiddenPaneKey] = makeAgentStatus(hiddenPaneKey)
    stubDocumentFocus({ visibilityState: 'visible', focused: true })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: hiddenPaneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-2')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(hiddenPaneKey)
  })

  it('marks a hidden split pane in the focused tab unread', () => {
    const siblingPaneKey = stalePaneKey
    mockState.activeWorktreeId = 'wt-primary'
    mockState.activeTabId = 'tab-1'
    mockState.ptyIdsByTabId['tab-1'] = ['pty-1', 'pty-2']
    mockState.terminalLayoutsByTabId['tab-1'] = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: liveLeafId },
        second: { type: 'leaf', leafId: staleLeafId }
      },
      activeLeafId: liveLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [liveLeafId]: 'pty-1', [staleLeafId]: 'pty-2' }
    }
    mockState.agentStatusByPaneKey[siblingPaneKey] = makeAgentStatus(siblingPaneKey)
    stubDocumentFocus({ visibilityState: 'visible', focused: true })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: siblingPaneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockState.markTerminalPaneUnread).toHaveBeenCalledWith(siblingPaneKey)
  })

  it('marks the selected worktree unread when Orca is backgrounded', () => {
    mockState.settings.experimentalTerminalAttention = false
    mockState.activeWorktreeId = 'wt-primary'
    stubDocumentFocus({ visibilityState: 'hidden', focused: false })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-primary')
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
    expect(mockState.markAgentCompletionPaneUnread).toHaveBeenCalledWith(paneKey)
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

  it('uses accepted hook snapshot timing for the notification id when the live store row is gone before dispatch', () => {
    mockState.ptyIdsByTabId = {}
    mockState.agentStatusByPaneKey = {}
    const stateStartedAt = Date.now() - 1_000

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey,
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'codex-hook-notify',
        agentType: 'codex',
        lastAssistantMessage: 'Done.',
        stateStartedAt
      }
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        notificationId: buildAgentNotificationId({
          worktreeId: 'wt-primary',
          paneKey,
          stateStartedAt
        }),
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

  it('drops a delayed completion snapshot when the pane has already started a newer turn', () => {
    const previousDoneStartedAt = Date.now() - 10_000
    mockState.agentStatusByPaneKey[paneKey] = makeAgentStatus(paneKey, {
      state: 'working',
      prompt: 'new prompt already running',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      lastAssistantMessage: undefined
    })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey,
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'previous prompt',
        agentType: 'codex',
        lastAssistantMessage: 'Done.',
        stateStartedAt: previousDoneStartedAt
      }
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markAgentCompletionPaneUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
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

  it('drops final-flush notifications for suppressed live ptys', () => {
    mockState.suppressedPtyExitIds = { 'pty-1': true }

    dispatchTerminalNotification('wt-primary', {
      source: 'terminal-bell',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
    expect(mockState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(mockState.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('drops layout-fallback notifications when all tab PTYs are suppressed', () => {
    mockState.suppressedPtyExitIds = { 'pty-1': true }
    mockState.terminalLayoutsByTabId['tab-1'] = {
      root: { type: 'leaf', leafId: 'leaf-1' },
      activeLeafId: 'leaf-1',
      expandedLeafId: null,
      ptyIdsByLeafId: {}
    }

    dispatchTerminalNotification('wt-primary', {
      source: 'terminal-bell',
      terminalTitle: 'codex',
      paneKey
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
