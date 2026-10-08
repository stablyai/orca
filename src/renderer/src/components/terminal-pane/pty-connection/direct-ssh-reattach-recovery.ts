import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function recoverUnverifiableDirectSshReattach(
  session: ConnectPanePtySession,
  ptyId: string | null | undefined
): void {
  // Read before settling: the settle clears the lease this branch tests.
  const directSshRetryOwnsRecovery = Boolean(session.directSshRetryAttempt)
  // Settle BEFORE requesting: this failure is the outcome of the remount that
  // mounted this pane. Requesting first would ask for a repeat of the action
  // that just failed while its ledger still read 'pending' — the storm.
  session.settlePaneAttachAttempt(session.directSshRetryAttempt, 'failed')
  if (directSshRetryOwnsRecovery) {
    return
  }
  void requestTerminalPaneRecovery({
    tabId: session.deps.tabId,
    ptyId: ptyId ?? null,
    reason: 'reattach-unverifiable',
    terminalRecoveryGeneration: session.terminalRecoveryGeneration,
    terminalRecoveryInstanceId: session.terminalRecoveryInstance.id
  })
}
