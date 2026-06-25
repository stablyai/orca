/* eslint-disable max-lines -- Why: notification edge cases share one module-scoped coordinator, so keeping setup and regression cases together prevents brittle cross-file mock resets. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'

const dispatchTerminalNotification = vi.fn()

type MockStoreState = {
  settings: {
    experimentalTerminalAttention?: boolean
    notifications: {
      enabled: boolean
      agentTaskComplete: boolean
    }
  }
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, boolean>
  tabsByWorktree: Record<string, { id: string; ptyId?: string | null }[]>
  terminalLayoutsByTabId: Record<
    string,
    {
      root: { type: 'leaf'; leafId: string } | null
      activeLeafId: string | null
      expandedLeafId: string | null
      ptyIdsByLeafId?: Record<string, string>
    }
  >
}

let mockStoreState: MockStoreState
const HOOK_DONE_QUIET_MS = 1_500

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
    vi.useFakeTimers()
    dispatchTerminalNotification.mockClear()
    mockStoreState = {
      settings: {
        experimentalTerminalAttention: false,
        notifications: {
          enabled: true,
          agentTaskComplete: true
        }
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      suppressedPtyExitIds: {},
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }]
      },
      terminalLayoutsByTabId: {}
    }
  })

  afterEach(() => {
    vi.useRealTimers()
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
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey,
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          agentType: 'codex',
          prompt: 'implement notifications',
          lastAssistantMessage: 'Done.'
        })
      })
    )
  }, 15_000)

  it('tracks hook completion for terminal attention when OS completion notifications are disabled', async () => {
    mockStoreState.settings.experimentalTerminalAttention = true
    mockStoreState.settings.notifications.agentTaskComplete = false
    const { observeAgentHookCompletionForNotification } =
      await import('./agent-hook-completion-notifications')

    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: hookStatus('done')
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey,
        suppressOsNotification: true
      })
    )
  }, 15_000)

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
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey,
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          agentType: 'codex',
          prompt: 'implement notifications',
          lastAssistantMessage: 'Done.'
        })
      })
    )
  })

  it('uses tab-level PTY liveness when an inactive layout is empty', async () => {
    mockStoreState.terminalLayoutsByTabId = {
      'tab-1': {
        root: null,
        activeLeafId: null,
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
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey,
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          agentType: 'codex',
          prompt: 'implement notifications',
          lastAssistantMessage: 'Done.'
        })
      })
    )
  })

  it('uses accepted hook status for an inactive tab before PTY liveness catches up', async () => {
    mockStoreState.ptyIdsByTabId = {
      'tab-1': []
    }
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
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey,
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          agentType: 'codex',
          prompt: 'implement notifications',
          lastAssistantMessage: 'Done.'
        })
      })
    )
  })

  it('carries hook stateStartedAt into delayed completion notifications', async () => {
    const { observeAgentHookCompletionForNotification } =
      await import('./agent-hook-completion-notifications')

    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: { ...hookStatus('working'), stateStartedAt: 1_700_000_000_000 }
    })
    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: { ...hookStatus('done'), stateStartedAt: 1_700_000_010_000 }
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey,
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          stateStartedAt: 1_700_000_010_000
        })
      })
    )
  })

  it('does not notify twice when the same done hook snapshot replays after activation', async () => {
    const { observeAgentHookCompletionForNotification } =
      await import('./agent-hook-completion-notifications')

    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: { ...hookStatus('working'), stateStartedAt: 1_700_000_000_000 }
    })
    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: { ...hookStatus('done'), stateStartedAt: 1_700_000_010_000 }
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)

    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: { ...hookStatus('done'), stateStartedAt: 1_700_000_010_000 }
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
  })

  it('prunes retained coordinators when pane liveness is removed from the store', async () => {
    const {
      _getAgentHookCompletionNotificationCoordinatorCountForTest,
      observeAgentHookCompletionForNotification,
      syncAgentHookCompletionNotificationSettings
    } = await import('./agent-hook-completion-notifications')

    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: hookStatus('working')
    })

    expect(_getAgentHookCompletionNotificationCoordinatorCountForTest()).toBe(1)

    mockStoreState.ptyIdsByTabId = {
      'tab-1': []
    }
    mockStoreState.tabsByWorktree = {}
    syncAgentHookCompletionNotificationSettings()

    expect(_getAgentHookCompletionNotificationCoordinatorCountForTest()).toBe(0)
  })

  it('does not start a coordinator for an intentionally suppressed pty', async () => {
    mockStoreState.ptyIdsByTabId = {
      'tab-1': []
    }
    mockStoreState.suppressedPtyExitIds = {
      'pty-1': true
    }
    const {
      _getAgentHookCompletionNotificationCoordinatorCountForTest,
      observeAgentHookCompletionForNotification
    } = await import('./agent-hook-completion-notifications')

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
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(_getAgentHookCompletionNotificationCoordinatorCountForTest()).toBe(0)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
  })

  it('does not notify on each Cursor shell tool hook during a working turn', async () => {
    const { observeAgentHookCompletionForNotification } =
      await import('./agent-hook-completion-notifications')

    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: {
        state: 'working',
        prompt: 'fix the bug',
        agentType: 'cursor'
      }
    })
    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: {
        state: 'working',
        prompt: 'fix the bug',
        agentType: 'cursor',
        toolName: 'Shell',
        toolInput: 'pnpm test'
      }
    })
    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: {
        state: 'working',
        prompt: 'fix the bug',
        agentType: 'cursor',
        toolName: 'Read',
        toolInput: '/repo/src/app.ts'
      }
    })

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
  })

  it('suppresses an internal milestone completion when hook work resumes before quiet', async () => {
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
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS - 1)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: hookStatus('working')
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    observeAgentHookCompletionForNotification({
      paneKey,
      worktreeId: 'wt-1',
      payload: hookStatus('done')
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey,
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          agentType: 'codex',
          prompt: 'implement notifications',
          lastAssistantMessage: 'Done.'
        })
      })
    )
  })
})
