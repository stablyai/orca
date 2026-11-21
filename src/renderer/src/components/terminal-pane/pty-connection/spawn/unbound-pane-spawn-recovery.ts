import { warnTerminalLifecycleAnomaly } from '../../layout/reconciliation/terminal-lifecycle-diagnostics'
import { requestTerminalPaneRecovery } from '../../render-health/recovery/terminal-pane-recovery'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { pendingSpawnByPaneKey } from './pending-pane-spawn'
import { armPaneOwnerRetry } from '../host-ownership/pane-owner-recovery'
import type { FreshSpawnOptions, PendingStartupCommand } from '../startup/fresh-spawn-types'

export function settleUnboundFreshSpawn(
  session: ConnectPanePtySession,
  generation: number,
  ownerRefused: boolean,
  startup: PendingStartupCommand | null | undefined,
  options: FreshSpawnOptions
): void {
  queueMicrotask(() => {
    if (
      session.disposed ||
      generation !== session.transportStreamGeneration ||
      session.transport.getPtyId() ||
      pendingSpawnByPaneKey.has(session.pendingSpawnKey)
    ) {
      return
    }
    if (ownerRefused) {
      armPaneOwnerRetry(
        session,
        generation,
        () => session.startFreshSpawn(startup, options),
        startup
      )
      session.settlePaneAttachAttempt?.('failed')
      return
    }
    if (!session.deferredSpawn) {
      settleSpawnThatLeftPaneUnbound(session)
    }
  })
}

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
