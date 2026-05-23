import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

type MockState = {
  activeWorktreeId: string | null
  tabsByWorktree: Record<string, { id: string }[]>
  ptyIdsByTabId: Record<string, string[]>
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
    notifications?: {
      customSoundPath?: string | null
    }
  }
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

describe('dispatchTerminalNotification', () => {
  const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'

  beforeEach(() => {
    vi.clearAllMocks()
    mockState = {
      activeWorktreeId: 'wt-secondary',
      tabsByWorktree: {},
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
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
      settings: { notifications: { customSoundPath: null } }
    }
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true })
        }
      }
    }
  })

  it('uses a live pane key when inactive worktree tab membership is not hydrated', () => {
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
  })

  it('still drops stale notifications when neither worktree nor pane has a live pty', () => {
    mockState.ptyIdsByTabId = {}

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })

    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
  })
})
