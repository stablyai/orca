import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useAppStore } from '@/store'
import { registerUndeliverableWriteHandler } from '@/lib/pane-manager/terminal-write-pipeline-health'
import { requestTerminalPaneRecovery } from '../../render-health/recovery/terminal-pane-recovery'
import { discardTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-queue-registry'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

// Bound connect grace so wedged RPCs cannot suppress input recovery forever; late reattach does not authorize killing pre-existing sessions.
const TRANSPORT_CONNECT_SETTLE_GRACE_MS = 60_000

export function installPtyInputRecovery(session: ConnectPanePtySession): void {
  // Live PTYs with detached bindings can reject input while showing cached frames; remount because dead-session checks cannot detect that state (#8104).
  session.transportConnectInFlightSince = null
  session.requestRecoveryForUndeliverableInput = (providerRejected = false): void => {
    if (
      !providerRejected &&
      session.transport.isConnected?.() &&
      session.transport.getPtyId() !== null
    ) {
      return
    }
    // Pending connect rejects are temporary; do not race remount against their live PTY, or against a successor after disposal.
    const connectStillSettling =
      session.transportConnectInFlightSince !== null &&
      Date.now() - session.transportConnectInFlightSince < TRANSPORT_CONNECT_SETTLE_GRACE_MS
    // Why: a transport that is retrying its own binding owns recovery; a remount would race it.
    const transportOwnsRecovery = !providerRejected && session.transport.ownsRecovery?.() === true
    if (connectStillSettling || transportOwnsRecovery || session.disposed) {
      return
    }
    const storePtyId = useAppStore.getState().ptyIdsByTabId?.[session.deps.tabId]?.[0] ?? null
    const undeliverablePtyId = session.transport.getPtyId() ?? storePtyId
    // Local main can prove local/SSH liveness but owns no remote-runtime registry; use the remote host’s rejection instead of fabricated local absence (STA-2830).
    const hostRejectedRemoteInput = providerRejected && isRemoteRuntimePtyId(undeliverablePtyId)
    void requestTerminalPaneRecovery({
      tabId: session.deps.tabId,
      ptyId: undeliverablePtyId,
      reason: hostRejectedRemoteInput ? 'input-rejected-by-host' : 'input-undeliverable',
      terminalRecoveryGeneration: session.terminalRecoveryGeneration,
      terminalRecoveryInstanceId: session.terminalRecoveryInstance.id,
      // Require authoritative remote/SSH liveness so local null results cannot cause repeated typing-driven remounts.
      requireAuthoritativeLiveness:
        Boolean(session.transport.getConnectionId?.()) || isRemoteRuntimePtyId(undeliverablePtyId),
      // Only host rejection can replace the shell and lose a partial line; stalled-pipeline recovery retains that line on the same PTY.
      endpointReplaced: providerRejected,
      // Check all panes at admission: one remount replaces siblings too, and input can arrive during the liveness probe.
      hasUndeliveredInput: () =>
        [...session.deps.paneTransportsRef.current.values()].some(
          (transport) => transport.hasUndeliveredInput?.() === true
        )
    })
  }
  // Route dead-pipeline certification through tab recovery; replacing xterm resets its per-instance certification.
  session.unregisterUndeliverableWriteHandler = registerUndeliverableWriteHandler(
    session.pane.terminal,
    (reason) => {
      // Release queued/detached output credit immediately on pipeline death.
      discardTerminalOutput(session.pane.terminal)
      const storePtyId = useAppStore.getState().ptyIdsByTabId?.[session.deps.tabId]?.[0] ?? null
      void requestTerminalPaneRecovery({
        tabId: session.deps.tabId,
        ptyId: session.transport.getPtyId() ?? storePtyId,
        reason,
        terminalRecoveryGeneration: session.terminalRecoveryGeneration,
        terminalRecoveryInstanceId: session.terminalRecoveryInstance.id
      })
    }
  )
}
