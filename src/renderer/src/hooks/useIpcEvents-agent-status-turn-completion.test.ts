import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildStoreState,
  FUTURE_PANE_KEY,
  type AgentStatusSetData,
  type StoreLike
} from './ipc-events-agent-status-store-test-fixtures'
import {
  buildWindowApi,
  stubAuxiliaryModules,
  stubReactSyncEffect
} from './ipc-events-agent-status-window-test-fixtures'

describe('useIpcEvents agent status turn completion', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('forwards source and host turn facts through the agent-status IPC whitelist', async () => {
    const setAgentStatus = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Claude' }]
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    vi.doMock('./agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification,
      resetAgentHookCompletionNotificationCoordinators: vi.fn(),
      syncAgentHookCompletionNotificationSettings: vi.fn(),
      syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }
    const event = {
      paneKey: FUTURE_PANE_KEY,
      tabId: 'tab-future',
      worktreeId: 'wt-1',
      state: 'working' as const,
      prompt: 'review the PR',
      agentType: 'claude',
      lastAssistantMessage: 'Which cells need hand-verification?',
      turnCompletedAt: 1_700_000_005_000,
      turnEndedAt: 1_700_000_005_001,
      turnEndDisposition: 'identified' as const,
      turnStartedAt: 1_700_000_000_000,
      terminalHandle: 'terminal-projection',
      receivedAt: 1_700_000_005_000,
      stateStartedAt: 1_700_000_000_000
    }
    onSetListenerRef.current(event)

    expect(observeAgentHookCompletionForNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: FUTURE_PANE_KEY,
        worktreeId: 'wt-1',
        payload: expect.objectContaining({
          state: 'working',
          agentType: 'claude',
          turnCompletedAt: 1_700_000_005_000,
          turnEndedAt: 1_700_000_005_001,
          turnEndDisposition: 'identified',
          turnStartedAt: 1_700_000_000_000,
          terminalHandle: 'terminal-projection',
          isReplay: false,
          lastAssistantMessage: 'Which cells need hand-verification?'
        })
      })
    )
  })
})
