import type { RuntimeStatus } from './runtime-session-contracts'
import { isRuntimeWorkspaceWindowClosed } from './runtime-workspace-window-availability'

export type RuntimeHostConnectionState =
  | 'connected'
  | 'runtime-unavailable'
  | 'workspace-window-closed'
  | 'checking'
  | 'reconnecting'
  | 'disconnected'

/** Derives the runtime transport verdict shared by the renderer and agents. */
export type RuntimeHostTransportState = 'connected' | 'checking' | 'disconnected'

export function runtimeHostConnectionState({
  hasStatusEntry,
  status,
  transportStatus = 'disconnected',
  remoteControl = null
}: {
  hasStatusEntry: boolean
  status: RuntimeStatus | null | undefined
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
    return transportState === 'checking' ? 'checking' : 'disconnected'
  }
  if (statusRemoteControl?.state === 'closed') {
    return 'disconnected'
  }
  if (statusRemoteControl && statusRemoteControl.state !== 'ready') {
    return 'checking'
  }
  if (isRuntimeWorkspaceWindowClosed(status)) {
    return 'workspace-window-closed'
  }
  return 'connected'
}

export function isConnectedRuntimeHostState(state: RuntimeHostConnectionState): boolean {
  return (
    state === 'connected' || state === 'runtime-unavailable' || state === 'workspace-window-closed'
  )
}

export type HostStatus = 'connected' | 'disconnected' | 'connecting'

export function runtimeStatusForOverall(state: RuntimeHostConnectionState): HostStatus {
  switch (state) {
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
