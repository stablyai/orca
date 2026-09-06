import type { RuntimeStatus } from '../../../shared/runtime-types'
import { isRuntimeWorkspaceWindowClosed } from '../../../shared/runtime-workspace-window-availability'

export type HostStatus = 'connected' | 'disconnected' | 'connecting'
export type RuntimeHostTransportState = 'connected' | 'checking' | 'disconnected'

// Why: 'workspace-window-closed' is a reachable host that cannot serve graph-backed
// work — connected for counting purposes, but not interchangeable with 'connected'.
export type RuntimeHostConnectionState =
  | 'connected'
  // The SSH/control transport is up, but the Orca runtime did not answer its
  // status probe. This is distinct from a disconnected transport.
  | 'runtime-unavailable'
  | 'workspace-window-closed'
  | 'checking'
  | 'reconnecting'
  | 'disconnected'

// Why: one derivation for every host surface (status bar + Settings > Available Hosts),
// so a degraded host can never read "Connected" in one place and "Ready" in the other.
export function runtimeHostConnectionState({
  hasStatusEntry,
  status,
  transportStatus = 'disconnected',
  remoteControl = null
}: {
  hasStatusEntry: boolean
  status: RuntimeStatus | null | undefined
  /** Transport evidence is independent from the runtime status RPC result. */
  transportStatus?: RuntimeHostTransportState
  remoteControl?: RuntimeStatus['remoteControl'] | null
}): RuntimeHostConnectionState {
  if (!hasStatusEntry) {
    return 'checking'
  }
  const transportState =
    remoteControl?.state === 'ready'
      ? 'connected'
      : remoteControl?.state === 'awaiting_ready' ||
          remoteControl?.state === 'awaiting_authenticated' ||
          remoteControl?.state === 'reconnecting'
        ? 'checking'
        : remoteControl?.state === 'closed'
          ? 'disconnected'
          : transportStatus
  const statusRemoteControl = status?.remoteControl ?? remoteControl
  if (statusRemoteControl?.state === 'reconnecting') {
    return 'reconnecting'
  }
  if (!status) {
    if (transportState === 'connected') {
      return 'runtime-unavailable'
    }
    // The control channel is still negotiating/reconnecting, so the host's
    // runtime outcome is not yet knowable.
    return transportState === 'checking' ? 'checking' : 'disconnected'
  }
  // Why no lastError requirement: a clean close (server restart, host sleep, network
  // blip) leaves lastError null, and demanding an error string painted those hosts green.
  if (statusRemoteControl?.state === 'closed') {
    return 'disconnected'
  }
  // Why: the socket is up but ready/auth has not completed, so nothing can run there yet.
  if (statusRemoteControl && statusRemoteControl.state !== 'ready') {
    return 'checking'
  }
  // Why: reachable but graph-less — the transport is fine, so this is not a network
  // disconnect, but calling it "Connected" hides that nothing will run there.
  if (isRuntimeWorkspaceWindowClosed(status)) {
    return 'workspace-window-closed'
  }
  // Why: "connected" means attached/reachable, NOT "is the active default host".
  // Both surfaces must agree on that single definition, or a reachable-but-not-active
  // host reads "Connected" in one place and "Available" in the other. Active/default is
  // a separate concept (surfaced elsewhere), so it must not change this state.
  return 'connected'
}

export function runtimeStatusForOverall(state: RuntimeHostConnectionState): HostStatus {
  switch (state) {
    // Why: a closed workspace window is a degraded host, not a lost connection —
    // it must keep counting toward the connected-host total.
    case 'connected':
    case 'runtime-unavailable':
    case 'workspace-window-closed':
      return 'connected'
    case 'checking':
    case 'reconnecting':
      return 'connecting'
    case 'disconnected':
      return 'disconnected'
  }
}

export function isConnectedRuntimeHostState(state: RuntimeHostConnectionState): boolean {
  return (
    state === 'connected' || state === 'runtime-unavailable' || state === 'workspace-window-closed'
  )
}
