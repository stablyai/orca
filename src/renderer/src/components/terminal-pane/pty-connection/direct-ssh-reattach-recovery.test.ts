import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import { recoverUnverifiableDirectSshReattach } from './direct-ssh-reattach-recovery'

vi.mock('../terminal-pane-recovery', () => ({
  requestTerminalPaneRecovery: vi.fn()
}))

describe('recoverUnverifiableDirectSshReattach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retries through the exact direct SSH lease when one exists', () => {
    const attempt = { attemptId: 'attempt-1' }
    const settlePaneAttachAttempt = vi.fn()

    recoverUnverifiableDirectSshReattach(
      { directSshRetryAttempt: attempt, settlePaneAttachAttempt } as never,
      'ssh:target@@pty-1'
    )

    expect(settlePaneAttachAttempt).toHaveBeenCalledExactlyOnceWith(attempt, 'failed')
    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })

  it('remounts over the preserved PTY when no retry lease exists', () => {
    const settlePaneAttachAttempt = vi.fn()
    recoverUnverifiableDirectSshReattach(
      {
        directSshRetryAttempt: undefined,
        settlePaneAttachAttempt,
        deps: { tabId: 'tab-1' },
        terminalRecoveryGeneration: 2,
        terminalRecoveryInstance: { id: 3 }
      } as never,
      'ssh:target@@pty-1'
    )

    // Settled before the re-request: this failure is the outcome of the
    // remount that mounted this pane, and the ledger must read it that way
    // before the pane asks for the same action again (crash b5cfc6ca).
    expect(settlePaneAttachAttempt).toHaveBeenCalledExactlyOnceWith(undefined, 'failed')
    expect(settlePaneAttachAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(requestTerminalPaneRecovery).mock.invocationCallOrder[0]
    )
    expect(requestTerminalPaneRecovery).toHaveBeenCalledExactlyOnceWith({
      tabId: 'tab-1',
      ptyId: 'ssh:target@@pty-1',
      reason: 'reattach-unverifiable',
      terminalRecoveryGeneration: 2,
      terminalRecoveryInstanceId: 3
    })
  })
})
