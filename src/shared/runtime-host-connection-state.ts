import type { RuntimeStatus } from './runtime-session-contracts'
import { isRuntimeWorkspaceWindowClosed } from './runtime-workspace-window-availability'

export type RuntimeHostConnectionState =
  | 'connected'
  | 'workspace-window-closed'
  | 'checking'
  | 'reconnecting'
  | 'disconnected'

/** Derives the runtime transport verdict shared by the renderer and agents. */
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
  if (remoteControl?.state === 'closed') {
    return 'disconnected'
  }
  if (remoteControl && remoteControl.state !== 'ready') {
    return 'checking'
  }
  if (isRuntimeWorkspaceWindowClosed(status)) {
    return 'workspace-window-closed'
  }
  return 'connected'
}

export function isConnectedRuntimeHostState(state: RuntimeHostConnectionState): boolean {
  return state === 'connected' || state === 'workspace-window-closed'
}

export type HostStatus = 'connected' | 'disconnected' | 'connecting'

export function runtimeStatusForOverall(state: RuntimeHostConnectionState): HostStatus {
  switch (state) {
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
