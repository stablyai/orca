import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import { settleSpawnThatLeftPaneUnbound } from './unbound-pane-spawn-recovery'

vi.mock('../terminal-pane-recovery', () => ({
  requestTerminalPaneRecovery: vi.fn()
}))

function buildSession(overrides: Record<string, unknown> = {}): never {
  return {
    deps: { tabId: 'tab-1', worktreeId: 'wt-1', restoredLeafId: 'leaf-1' },
    pane: { id: 4, leafId: 'pane-leaf' },
    terminalRecoveryGeneration: 2,
    terminalRecoveryInstance: { id: 3 },
    directSshRetryAttempt: undefined,
    settleDirectSshPaneRetryAttempt: vi.fn(),
    ...overrides
  } as never
}

describe('settleSpawnThatLeftPaneUnbound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('remounts the tab so the pane rebinds over its live PTY', () => {
    settleSpawnThatLeftPaneUnbound(buildSession())

    expect(requestTerminalPaneRecovery).toHaveBeenCalledExactlyOnceWith({
      tabId: 'tab-1',
      ptyId: null,
      reason: 'spawn-left-pane-unbound',
      terminalRecoveryGeneration: 2,
      terminalRecoveryInstanceId: 3
    })
  })

  it('leaves recovery to the direct SSH retry ledger when it holds a lease', () => {
    const attempt = { attemptId: 'attempt-1' }
    const settleDirectSshPaneRetryAttempt = vi.fn()

    settleSpawnThatLeftPaneUnbound(
      buildSession({ directSshRetryAttempt: attempt, settleDirectSshPaneRetryAttempt })
    )

    expect(settleDirectSshPaneRetryAttempt).toHaveBeenCalledExactlyOnceWith(attempt, 'failed')
    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })

  it('settles the spawn as failed before remounting', () => {
    const settleDirectSshPaneRetryAttempt = vi.fn()

    settleSpawnThatLeftPaneUnbound(
      buildSession({ deps: { tabId: 'tab-settle' }, settleDirectSshPaneRetryAttempt })
    )

    expect(settleDirectSshPaneRetryAttempt).toHaveBeenCalledExactlyOnceWith(undefined, 'failed')
    expect(requestTerminalPaneRecovery).toHaveBeenCalledOnce()
  })

  // Distinct ids per case: warnTerminalLifecycleAnomaly dedups on a module-global key.
  it('prefers the restored leaf id when reporting the anomaly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    settleSpawnThatLeftPaneUnbound(
      buildSession({ deps: { tabId: 'tab-warn', worktreeId: 'wt-1', restoredLeafId: 'leaf-1' } })
    )

    expect(warn).toHaveBeenCalledWith(
      '[terminal-lifecycle] fresh spawn left the pane unbound',
      expect.objectContaining({ leafId: 'leaf-1', paneId: 4, worktreeId: 'wt-1' })
    )
    warn.mockRestore()
  })

  it('falls back to the pane leaf id when no restored leaf exists', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    settleSpawnThatLeftPaneUnbound(
      buildSession({ deps: { tabId: 'tab-2', worktreeId: 'wt-2', restoredLeafId: null } })
    )

    expect(warn).toHaveBeenCalledWith(
      '[terminal-lifecycle] fresh spawn left the pane unbound',
      expect.objectContaining({ leafId: 'pane-leaf' })
    )
    warn.mockRestore()
  })
})
