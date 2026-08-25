import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import { TERMINAL_PANE_OWNER_UNVERIFIED } from '../../../../../shared/terminal-pane-owner-verdict'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function recoverUnverifiableReattach(
  session: ConnectPanePtySession,
  ptyId: string | null | undefined
): void {
  const reportOwnerUnverifiable = (): void => {
    session.deps?.onPtyErrorRef?.current?.(session.pane?.id ?? 0, TERMINAL_PANE_OWNER_UNVERIFIED)
  }
  if (session.directSshRetryAttempt) {
    reportOwnerUnverifiable()
    session.settleDirectSshPaneRetryAttempt(session.directSshRetryAttempt, 'failed')
    return
  }
  // Keep the pane mounted so the user gets an explicit retry action. An
  // automatic remount made an owner-routing failure look like a blank pane.
  if (session.deps?.onPtyErrorRef?.current) {
    reportOwnerUnverifiable()
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
