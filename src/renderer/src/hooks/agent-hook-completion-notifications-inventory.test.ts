import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCompletionStatusSnapshot } from '@/components/terminal-pane/agent-completion-coordinator-types'

const dispatchTerminalNotification = vi.fn()
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const mockStoreState = {
  settings: {
    experimentalTerminalAttention: false,
    notifications: { enabled: true, agentTaskComplete: true }
  },
  ptyIdsByTabId: { 'tab-1': ['pty-1'] },
  suppressedPtyExitIds: {},
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] },
  terminalLayoutsByTabId: {},
  agentLaunchConfigByPaneKey: {},
  agentStatusByPaneKey: {},
  getAgentLaunchConfigForStatusEntry: () => undefined,
  getAgentLaunchConfigForStatusMetadata: () => undefined
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => mockStoreState } }))
vi.mock('@/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))
vi.mock('@/components/terminal-pane/agent-hook-terminal-lifecycle', () => ({
  dispatchAgentHookTerminalLifecycle: vi.fn()
}))

function status(
  state: AgentCompletionStatusSnapshot['state'],
  stateStartedAt: number,
  agentType = 'codex'
): AgentCompletionStatusSnapshot {
  return { state, stateStartedAt, prompt: 'implement notifications', agentType }
}

describe('agent hook inventory notification baselines', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalNotification.mockClear()
  })

  afterEach(() => vi.useRealTimers())

  it('seeds cold terminal identity and observes only a later transition', async () => {
    const { observeAgentHookCompletionForNotification: observe } =
      await import('./agent-hook-completion-notifications')
    const coldDone = status('done', 100)

    observe({ paneKey: PANE_KEY, worktreeId: 'wt-1', payload: coldDone, seedOnly: true })
    observe({
      paneKey: PANE_KEY,
      worktreeId: 'wt-1',
      payload: { ...coldDone, lastAssistantMessage: 'metadata refresh' },
      seedOnly: true
    })
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    observe({
      paneKey: PANE_KEY,
      worktreeId: 'wt-1',
      payload: status('done', 200)
    })
    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
  })

  it('seeds cold attention identity and observes only a later permission prompt', async () => {
    const { observeAgentHookCompletionForNotification: observe } =
      await import('./agent-hook-completion-notifications')
    const coldBlocked = status('blocked', 100)

    observe({ paneKey: PANE_KEY, worktreeId: 'wt-1', payload: coldBlocked, seedOnly: true })
    observe({ paneKey: PANE_KEY, worktreeId: 'wt-1', payload: coldBlocked, seedOnly: true })
    vi.advanceTimersByTime(1_500)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    observe({
      paneKey: PANE_KEY,
      worktreeId: 'wt-1',
      payload: status('blocked', 200)
    })
    vi.advanceTimersByTime(1_500)
    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
  })

  it('observes a stamped Claude completion after a cold working seed', async () => {
    const { observeAgentHookCompletionForNotification: observe } =
      await import('./agent-hook-completion-notifications')

    observe({
      paneKey: PANE_KEY,
      worktreeId: 'wt-1',
      payload: status('working', 100, 'claude'),
      seedOnly: true
    })
    observe({
      paneKey: PANE_KEY,
      worktreeId: 'wt-1',
      payload: { ...status('working', 100, 'claude'), turnCompletedAt: 200 }
    })

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
  })
})
