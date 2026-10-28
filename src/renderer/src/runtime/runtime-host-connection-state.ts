import { runtimeHostContactFromSnapshot } from '../../../shared/runtime-host-contact'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { isRuntimeWorkspaceWindowClosed } from '../../../shared/runtime-workspace-window-availability'

export type HostStatus = 'connected' | 'disconnected' | 'connecting'
export type RuntimeHostTransportState = 'connected' | 'checking' | 'disconnected'

// Closed workspace windows leave reachable but graph-less hosts; count connected while preserving degraded status.
export type RuntimeHostConnectionState =
  | 'connected'
  // Live SSH/control transport with unanswered runtime probe is distinct from disconnected.
  | 'runtime-unavailable'
  | 'workspace-window-closed'
  | 'checking'
  | 'reconnecting'
  | 'disconnected'

// Share derivation across status bar/Settings so degraded hosts get consistent labels.
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
    // Negotiating/reconnecting transport cannot yet prove runtime outcome.
    return transportState === 'checking' ? 'checking' : 'disconnected'
  }
  // Clean closes leave no lastError; requiring one falsely paints dead hosts green.
  if (statusRemoteControl?.state === 'closed') {
    return 'disconnected'
  }
  // Why: the socket is up but ready/auth has not completed, so nothing can run there yet.
  if (statusRemoteControl && statusRemoteControl.state !== 'ready') {
    return 'checking'
  }
  // Reachable but graph-less is degraded: transport works, but Connected hides that no work runs.
  if (isRuntimeWorkspaceWindowClosed(status)) {
    return 'workspace-window-closed'
  }
  // Connected means reachable regardless of active/default selection; every surface must use that definition.
  return 'connected'
}

export function runtimeStatusForOverall(state: RuntimeHostConnectionState): HostStatus {
  switch (state) {
    // Closed workspace windows degrade runtime service, not contact; retain connected-host count.
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

/**
 * Only this verdict earns the destructive glyph. 'checking' and 'reconnecting' are
 * unverifiable, not down, per docs/reference/ssh-execution-boundary.md.
 */
export function isDisconnectedRuntimeHostState(state: RuntimeHostConnectionState): boolean {
  return state === 'disconnected'
}

/** The same derivation, read straight off a recorded status entry. */
export function runtimeHostConnectionStateForEntry(
  entry:
    | {
        status: RuntimeStatus | null
        remoteControl?: RuntimeStatus['remoteControl'] | null
        snapshot?: RuntimeHostStatusSnapshot
      }
    | null
    | undefined
): RuntimeHostConnectionState {
  const snapshot = entry?.snapshot
  if (snapshot) {
    // Name nonverified contact outcomes once so readers choose an arm instead of guessing from null snapshot fields.
    const contact = runtimeHostContactFromSnapshot(snapshot, entry?.status ?? null)
    if (contact.verdict === 'retired' || contact.verdict === 'refused') {
      return 'disconnected'
    }
    if (contact.verdict === 'unverifiable') {
      if (contact.reason === 'transport-down') {
        return 'reconnecting'
      }
      if (contact.reason === 'checking') {
        return 'checking'
      }
      if (contact.reason === 'probe-failed') {
        return 'runtime-unavailable'
      }
    }
  }
  return runtimeHostConnectionState({
    hasStatusEntry: Boolean(entry),
    status: entry?.status ?? null,
    // Connecting is ongoing negotiation; unknown is never attempted and may remain so permanently. Calling unknown checking hides Connect and pins the spinner forever.
    ...(snapshot?.transport === 'connecting' ? { transportStatus: 'checking' as const } : {}),
    remoteControl: entry?.remoteControl ?? entry?.status?.remoteControl ?? null
  })
}
