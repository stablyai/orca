import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'

const dispatchTerminalNotification = vi.fn()

type MockStoreState = {
  settings: {
    notifications: {
      enabled: boolean
      agentTaskComplete: boolean
    }
  }
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<
    string,
    {
      root: { type: 'leaf'; leafId: string }
      activeLeafId: string
      expandedLeafId: string | null
      ptyIdsByLeafId?: Record<string, string>
    }
  >
}

let mockStoreState: MockStoreState

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

vi.mock('@/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))

function hookStatus(state: ParsedAgentStatusPayload['state']): ParsedAgentStatusPayload {
  return {
    state,
    prompt: 'implement notifications',
    agentType: 'codex',
    lastAssistantMessage: state === 'done' ? 'Done.' : undefined
  }
}

describe('agent hook completion notifications', () => {
  const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'

  beforeEach(() => {
    vi.resetModules()
    dispatchTerminalNotification.mockClear()
    mockStoreState = {
      settings: {
        notifications: {
          enabled: true,
          agentTaskComplete: true
        }
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      terminalLayoutsByTabId: {}
    }
  })

  it('requires fresh working after notifications start disabled and later re-enable', async () => {
    mockStoreState.settings.notifications.agentTaskComplete = false
    const {
      observeAgentHookCompletionForNotification,
      syncAgentHookCompletionNotificationSettings
    } = await import('./agent-hook-completion-notifications')

    mockStoreState.settings.notifications.agentTaskComplete = true
    syncAgentHookCompletionNotificationSettings()

    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: hookStatus('done')
    })

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: hookStatus('working')
    })
    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: hookStatus('done')
    })

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey
      })
    )
  })

  it('uses tab-level PTY liveness when an inactive pane leaf binding is temporarily missing', async () => {
    mockStoreState.terminalLayoutsByTabId = {
      'tab-1': {
        root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
        activeLeafId: '11111111-1111-4111-8111-111111111111',
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
    }
    const { observeAgentHookCompletionForNotification } =
      await import('./agent-hook-completion-notifications')

    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: hookStatus('working')
    })
    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: hookStatus('done')
    })

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey
      })
    )
  })
})
