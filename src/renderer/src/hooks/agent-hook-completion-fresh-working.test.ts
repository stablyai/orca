import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'

const dispatchTerminalNotification = vi.fn()
const dispatchAgentHookTerminalLifecycle = vi.fn()

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const WORKTREE_ID = 'wt-1'

type MockStoreState = {
  settings: {
    experimentalTerminalAttention: boolean
    notifications: { enabled: boolean; agentTaskComplete: boolean }
  }
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, boolean>
  tabsByWorktree: Record<string, { id: string; ptyId: string }[]>
  terminalLayoutsByTabId: Record<string, unknown>
  agentLaunchConfigByPaneKey: Record<string, unknown>
  agentStatusByPaneKey: Record<string, unknown>
  getAgentLaunchConfigForStatusEntry: () => undefined
  getAgentLaunchConfigForStatusMetadata: () => undefined
}

let mockStoreState: MockStoreState

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

vi.mock('@/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))

vi.mock('@/components/terminal-pane/agent-hook-terminal-lifecycle', () => ({
  dispatchAgentHookTerminalLifecycle
}))

function working(turnCompletedAt?: number): ParsedAgentStatusPayload {
  return {
    state: 'working',
    prompt: 'implement notifications',
    agentType: 'claude',
    lastAssistantMessage: turnCompletedAt === undefined ? undefined : 'Turn complete.',
    turnCompletedAt
  }
}

describe('agent hook completion fresh-working gate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalNotification.mockClear()
    dispatchAgentHookTerminalLifecycle.mockClear()
    mockStoreState = {
      settings: {
        experimentalTerminalAttention: false,
        notifications: { enabled: true, agentTaskComplete: false }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      suppressedPtyExitIds: {},
      tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1', ptyId: 'pty-1' }] },
      terminalLayoutsByTabId: {},
      agentLaunchConfigByPaneKey: {},
      agentStatusByPaneKey: {},
      getAgentLaunchConfigForStatusEntry: () => undefined,
      getAgentLaunchConfigForStatusMetadata: () => undefined
    }
  })

  afterEach(() => vi.useRealTimers())

  it('stays gated through a stamped working completion after re-enable', async () => {
    const {
      observeAgentHookCompletionForNotification,
      syncAgentHookCompletionNotificationSettings
    } = await import('./agent-hook-completion-notifications')

    syncAgentHookCompletionNotificationSettings()
    observeAgentHookCompletionForNotification({
      paneKey: PANE_KEY,
      worktreeId: WORKTREE_ID,
      payload: { ...working(), stateStartedAt: 1_000 }
    })

    mockStoreState.settings.notifications.agentTaskComplete = true
    syncAgentHookCompletionNotificationSettings()
    observeAgentHookCompletionForNotification({
      paneKey: PANE_KEY,
      worktreeId: WORKTREE_ID,
      payload: working(1_500)
    })

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    observeAgentHookCompletionForNotification({
      paneKey: PANE_KEY,
      worktreeId: WORKTREE_ID,
      payload: { ...working(), stateStartedAt: 2_000 }
    })
    observeAgentHookCompletionForNotification({
      paneKey: PANE_KEY,
      worktreeId: WORKTREE_ID,
      payload: { ...working(2_500), stateStartedAt: 2_000 }
    })

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      WORKTREE_ID,
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey: PANE_KEY,
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          turnCompletedAt: 2_500,
          lastAssistantMessage: 'Turn complete.'
        })
      })
    )
  })
})
