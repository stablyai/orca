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
    const settleDirectSshPaneRetryAttempt = vi.fn()

    recoverUnverifiableDirectSshReattach(
      { directSshRetryAttempt: attempt, settleDirectSshPaneRetryAttempt } as never,
      'ssh:target@@pty-1'
    )

    expect(settleDirectSshPaneRetryAttempt).toHaveBeenCalledExactlyOnceWith(attempt, 'failed')
    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })

  it('remounts over the preserved PTY when no retry lease exists', () => {
    recoverUnverifiableDirectSshReattach(
      {
        directSshRetryAttempt: undefined,
        deps: { tabId: 'tab-1' },
        terminalRecoveryGeneration: 2,
        terminalRecoveryInstance: { id: 3 }
      } as never,
      'ssh:target@@pty-1'
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
