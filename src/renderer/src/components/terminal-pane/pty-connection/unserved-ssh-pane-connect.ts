import { useAppStore } from '@/store'
import { isRuntimeOwnedSshTargetId } from '../../../../../shared/execution-host'
import { isSshConnectInFlight, trackSshConnect } from '@/ssh/ssh-connect-in-flight'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { PtyTransport } from '../pty-transport-types'
import { createUnresolvedOwnerPtyTransport } from '../unresolved-owner-pty-transport'
import { createLegacyRelayBridgeTransport } from '../legacy-relay-bridge-transport'
import {
  legacyRelayBridgePtyIdForPane,
  releaseLegacyRelayBridgePaneClaim
} from '../legacy-relay-bridge-panes'

/** Inert: the reconnect overlay and the host's conversion own this pane, so input never remounts it. */
function createUnservedSshPaneTransport(): PtyTransport {
  return {
    ...createUnresolvedOwnerPtyTransport(
      'SSH connection is not active. Use the reconnect dialog or Settings to connect.'
    ),
    ownsRecovery: () => true
  }
}

/** COMPAT(legacy-relay-bridge): the host stayed unmoved, and connected, for terminals the bridge serves. */
function isBridgedUnservedSshTarget(targetId: string): boolean {
  // Why not status: a dropped link keeps this, and the bridge holds its panes until it returns.
  const server = useAppStore.getState().sshConnectionStates.get(targetId)?.managedServer
  return server?.kind === 'relay' && server.bridged === true
}

/**
 * COMPAT(legacy-relay-bridge, revisit 2027-01-15): on a host that stayed unmoved for them, a relay
 * terminal main reports serving reattaches in its relay-era tab; every other pane stays inert.
 */
export function createUnservedSshRowTransport(
  session: ConnectPanePtySession,
  targetId: string
): PtyTransport {
  const inert = createUnservedSshPaneTransport()
  if (!isBridgedUnservedSshTarget(targetId)) {
    return inert
  }
  const tabId = session.deps.tabId
  const leafId = session.deps.restoredLeafId ?? session.pane.leafId
  // Why no bound id: only a pane main lists may skip the dial that converts the host.
  const ptyId = legacyRelayBridgePtyIdForPane({ tabId, leafId, boundPtyId: null })
  if (!ptyId) {
    return inert
  }
  session.legacyRelayBridgePtyId = ptyId
  const bridged = createLegacyRelayBridgeTransport(ptyId, inert)
  // Why both: an unmount detaches a bound pane, and either frees the shell for a converted row.
  const release = (): void => releaseLegacyRelayBridgePaneClaim(ptyId, tabId, leafId)
  return {
    ...bridged,
    detach: (options) => {
      release()
      bridged.detach?.(options)
    },
    destroy: (options) => {
      release()
      return bridged.destroy?.(options)
    }
  }
}

/** Relay-era panes never spawn; overlay-driven conversion remounts them. Dial at mount unless passphrase authentication needs explicit user action. */
export function connectUnservedSshPaneTarget(
  session: ConnectPanePtySession,
  targetId: string
): void {
  // Runtime-owned targets are dialed by the runtime layer; a removed target can never connect.
  const state = useAppStore.getState()
  if (
    isRuntimeOwnedSshTargetId(targetId) ||
    (state.sshTargetLabels instanceof Map && !state.sshTargetLabels.has(targetId))
  ) {
    return
  }
  const isConnected = (): boolean =>
    useAppStore.getState().sshConnectionStates.get(targetId)?.status === 'connected'
  if (isConnected()) {
    return
  }
  void (async () => {
    let needsPrompt = false
    try {
      needsPrompt = await window.api.ssh.needsPassphrasePrompt({ targetId })
    } catch (err) {
      // Why: a stuck tab is worse than a surprising prompt.
      console.warn('[pty-connection] needsPassphrasePrompt probe failed:', err)
    }
    if (session.disposed || needsPrompt || isConnected() || isSshConnectInFlight(targetId)) {
      return
    }
    try {
      await trackSshConnect(targetId, window.api.ssh.connect({ targetId, automatic: true }))
    } catch (err) {
      console.warn(`[pty-connection] SSH connect failed for ${targetId}:`, err)
      session.reportError(
        `SSH connection failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })()
}
