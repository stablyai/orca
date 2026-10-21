import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Settle a spawn that resolved without a PTY id, remounting the pane when
 *  nothing else owns its recovery.
 *
 *  Why this is not self-correcting: the pane stays mounted with no transport
 *  binding, so `registerData` never runs. Main keeps pushing pty:data for the
 *  old id, the dispatcher finds no handler and buffers it in the pre-handler
 *  buffer — which claims no delivery credit, so the bytes are ACKed anyway and
 *  main's flow control reads healthy while the pane displays its last frame
 *  forever. The visibility reconciler skips unbound panes, so nothing else
 *  rebinds one. A remount reattaches over the still-live PTY and drains the
 *  buffer.
 *
 *  A transport that armed or parked its own retry owns the pane, so a second
 *  remount never races it. */
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
