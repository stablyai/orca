import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Settle a spawn that resolved without a PTY id, remounting the pane when
 *  nothing else owns its recovery.
 *
 *  Why this is not self-correcting: the pane stays mounted with no transport
 *  binding, so `registerData` never runs. Main keeps pushing pty:data for the
 *  old id and the dispatcher parks it in the pre-handler buffer. The visibility
 *  reconciler skips unbound panes, so nothing else rebinds one. A remount
 *  reattaches over the still-live PTY and drains the buffer.
 *
 *  The watchdog also detects persistent parked output independently of delivery
 *  credit, but needs two 15s ticks and incoming bytes. This seam handles a
 *  data-silent pane immediately.
 *
 *  A direct-SSH lease runs its own retry ledger, so it keeps ownership here and
 *  a second remount never races it. */
export function settleSpawnThatLeftPaneUnbound(session: ConnectPanePtySession): void {
  // Read before settling: the settle clears the lease this branch tests.
  const directSshRetryOwnsRecovery = Boolean(session.directSshRetryAttempt)
  session.settleDirectSshPaneRetryAttempt(session.directSshRetryAttempt, 'failed')
  if (directSshRetryOwnsRecovery) {
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
