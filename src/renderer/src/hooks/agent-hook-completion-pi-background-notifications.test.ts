import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dispatchTerminalNotification = vi.fn()
const dispatchAgentHookTerminalLifecycle = vi.fn()

let mockStoreState: {
  settings: {
    experimentalTerminalAttention: boolean
    notifications: { enabled: boolean; agentTaskComplete: boolean }
  }
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, boolean>
  tabsByWorktree: Record<string, { id: string; ptyId: string }[]>
  terminalLayoutsByTabId: Record<string, never>
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

vi.mock('@/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))

vi.mock('@/components/terminal-pane/agent-hook-terminal-lifecycle', () => ({
  dispatchAgentHookTerminalLifecycle
}))

vi.mock('@/components/terminal-pane/codex-auto-approval-notification-suppression', () => ({
  createCodexAutoApprovalHookCompletionSuppressor: () => () => false
}))

describe('Pi background hook completion notifications', () => {
  const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
  const working = {
    state: 'working' as const,
    prompt: 'delegate in background',
    agentType: 'pi' as const
  }
  const done = { ...working, state: 'done' as const }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalNotification.mockClear()
    dispatchAgentHookTerminalLifecycle.mockClear()
    mockStoreState = {
      settings: {
        experimentalTerminalAttention: false,
        notifications: { enabled: true, agentTaskComplete: true }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      suppressedPtyExitIds: {},
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] },
      terminalLayoutsByTabId: {}
    }
  })

  afterEach(() => vi.useRealTimers())

  it('waits for the deferred effective-idle status and notifies exactly once', async () => {
    const { observeAgentHookCompletionForNotification } =
      await import('./agent-hook-completion-notifications')

    observeAgentHookCompletionForNotification({ paneKey, worktreeId: 'wt-1', payload: working })
    // Parent settlement is withheld upstream while an async child remains active.
    vi.advanceTimersByTime(3_000)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    observeAgentHookCompletionForNotification({ paneKey, worktreeId: 'wt-1', payload: done })
    vi.advanceTimersByTime(1_500)
    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)

    observeAgentHookCompletionForNotification({ paneKey, worktreeId: 'wt-1', payload: done })
    vi.advanceTimersByTime(1_500)
    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
  })
})
