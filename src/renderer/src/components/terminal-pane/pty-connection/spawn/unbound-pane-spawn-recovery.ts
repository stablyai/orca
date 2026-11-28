import { warnTerminalLifecycleAnomaly } from '../../layout/reconciliation/terminal-lifecycle-diagnostics'
import { requestTerminalPaneRecovery } from '../../render-health/recovery/terminal-pane-recovery'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { unboundSpawnOutcome } from '../../../../../../shared/workspace-layout/closed-pane-spawn-refusal'

/** Owner refusals retry and closed-pane refusals wait for main's frame; recover other unbound successful connects by remount: no handler or visibility reconcile can rebind them while main ACKs buffered bytes. Respect transport-owned retries so recovery cannot race them. */
export function settleSpawnThatLeftPaneUnbound(
  session: ConnectPanePtySession,
  refusal: { ownerRefused: boolean; paneClosed: boolean },
  armOwnerRetry: () => void
): void {
  const outcome = unboundSpawnOutcome({ ...refusal, deferred: Boolean(session.deferredSpawn) })
  if (outcome === 'wait') {
    return
  }
  if (outcome === 'owner-retry') {
    armOwnerRetry()
    session.settlePaneAttachAttempt('failed')
    return
  }
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
