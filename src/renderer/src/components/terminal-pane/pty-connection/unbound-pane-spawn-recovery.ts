import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Recover unbound successful connects by remount: no handler or visibility reconcile can rebind them while main ACKs buffered bytes. Respect transport-owned retries so recovery cannot race them. */
export function settleSpawnThatLeftPaneUnbound(session: ConnectPanePtySession): void {
  session.settlePaneAttachAttempt('failed')
  if (session.transport.ownsRecovery?.() === true) {
    return
  }
  warnTerminalLifecycleAnomaly('fresh spawn left the pane unbound', {
    tabId: session.deps.tabId,
    worktreeId: session.deps.worktreeId,
    leafId: session.deps.restoredLeafId ?? session.pane.leafId,
    paneId: session.pane.id,
    ptyId: null
  })
  void requestTerminalPaneRecovery({
    tabId: session.deps.tabId,
    ptyId: null,
    reason: 'spawn-left-pane-unbound',
    terminalRecoveryGeneration: session.terminalRecoveryGeneration,
    terminalRecoveryInstanceId: session.terminalRecoveryInstance.id
  })
}
