import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

const playDesktopNotificationSound = vi.hoisted(() => vi.fn())
let mockState: ReturnType<typeof makeMockState>

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockState
  }
}))

vi.mock('@/lib/desktop-notification-sound', () => ({
  playDesktopNotificationSound
}))

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = `tab-1:${leafId}`
const dispatchContext = { taskId: 'task-1', dispatchId: 'dispatch-1' }

function makeAgentStatus(): AgentStatusEntry {
  const now = Date.now()
  return {
    state: 'done',
    prompt: 'ship the slice',
    updatedAt: now,
    stateStartedAt: now,
    agentType: 'claude',
    paneKey,
    terminalTitle: 'claude',
    stateHistory: [],
    lastAssistantMessage: 'Done.'
  }
}

function makeMockState() {
  const layout: TerminalLayoutSnapshot = {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: 'pty-1' }
  }
  return {
    activeWorktreeId: 'wt-other',
    activeTabId: 'tab-1',
    tabsByWorktree: { 'wt-worker': [{ id: 'tab-1', ptyId: 'pty-1' }] },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    suppressedPtyExitIds: {},
    terminalLayoutsByTabId: { 'tab-1': layout },
    browserTabsByWorktree: {},
    retainedAgentsByPaneKey: {},
    agentStatusByPaneKey: { [paneKey]: makeAgentStatus() },
    runtimeAgentOrchestrationByPaneKey: {} as Record<string, typeof dispatchContext>,
    worktreesByRepo: {
      repo1: [
        { id: 'wt-worker', repoId: 'repo1', displayName: 'worker', branch: 'worker' },
        { id: 'wt-other', repoId: 'repo1', displayName: 'other', branch: 'other' }
      ]
    },
    repos: [{ id: 'repo1', displayName: 'orca', connectionId: null }],
    settings: {
      experimentalTerminalAttention: true,
      notifications: { customSoundPath: null, dispatchedWorkerTaskComplete: true }
    },
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    markAgentCompletionPaneUnread: vi.fn()
  }
}

describe('dispatched worker notification suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState = makeMockState()
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

  it('still alerts for a dispatched worker while the setting is on', () => {
    mockState.runtimeAgentOrchestrationByPaneKey = { [paneKey]: dispatchContext }

    dispatchTerminalNotification('wt-worker', {
      source: 'agent-task-complete',
      terminalTitle: 'claude',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledOnce()
  })

  it('drops the banner and the phone push for a dispatched worker once the setting is off', () => {
    mockState.settings.notifications.dispatchedWorkerTaskComplete = false
    mockState.runtimeAgentOrchestrationByPaneKey = { [paneKey]: dispatchContext }

    dispatchTerminalNotification('wt-worker', {
      source: 'agent-task-complete',
      terminalTitle: 'claude',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
  })

  it('keeps in-app unread state for the suppressed worker', () => {
    mockState.settings.notifications.dispatchedWorkerTaskComplete = false
    mockState.runtimeAgentOrchestrationByPaneKey = { [paneKey]: dispatchContext }

    dispatchTerminalNotification('wt-worker', {
      source: 'agent-task-complete',
      terminalTitle: 'claude',
      paneKey
    })

    expect(mockState.markWorktreeUnread).toHaveBeenCalledWith('wt-worker')
    expect(mockState.markAgentCompletionPaneUnread).toHaveBeenCalledWith(paneKey)
    expect(mockState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
  })

  it('keeps alerting for the coordinator pane with the setting off', () => {
    mockState.settings.notifications.dispatchedWorkerTaskComplete = false

    dispatchTerminalNotification('wt-worker', {
      source: 'agent-task-complete',
      terminalTitle: 'claude',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledOnce()
  })

  it('leaves terminal bells alone', () => {
    mockState.settings.notifications.dispatchedWorkerTaskComplete = false
    mockState.runtimeAgentOrchestrationByPaneKey = { [paneKey]: dispatchContext }

    dispatchTerminalNotification('wt-worker', {
      source: 'terminal-bell',
      terminalTitle: 'claude',
      paneKey
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledOnce()
  })
})
