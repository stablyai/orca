import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function recoverUnverifiableDirectSshReattach(
  session: ConnectPanePtySession,
  ptyId: string | null | undefined
): void {
  if (session.directSshRetryAttempt) {
    session.settleDirectSshPaneRetryAttempt(session.directSshRetryAttempt, 'failed')
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
