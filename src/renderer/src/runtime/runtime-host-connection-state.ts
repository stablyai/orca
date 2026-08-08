import type { RuntimeStatus } from '../../../shared/runtime-types'
import { isRuntimeWorkspaceWindowClosed } from '../../../shared/runtime-workspace-window-availability'

export type HostStatus = 'connected' | 'disconnected' | 'connecting'

// Why: 'workspace-window-closed' is a reachable host that cannot serve graph-backed
// work — connected for counting purposes, but not interchangeable with 'connected'.
export type RuntimeHostConnectionState =
  | 'connected'
  | 'workspace-window-closed'
  | 'checking'
  | 'reconnecting'
  | 'disconnected'

// Why: one derivation for every host surface (status bar + Settings > Available Hosts),
// so a degraded host can never read "Connected" in one place and "Ready" in the other.
export function runtimeHostConnectionState({
  hasStatusEntry,
  status
}: {
  hasStatusEntry: boolean
  status: RuntimeStatus | null | undefined
}): RuntimeHostConnectionState {
  if (!hasStatusEntry) {
    return 'checking'
  }
  const remoteControl = status?.remoteControl
  if (remoteControl?.state === 'reconnecting') {
    return 'reconnecting'
  }
  if (!status) {
    return 'disconnected'
  }
  if (remoteControl?.state === 'closed' && remoteControl.lastError) {
    return 'disconnected'
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
  return state === 'connected' || state === 'workspace-window-closed'
}
