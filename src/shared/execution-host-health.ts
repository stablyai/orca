import type { SshConnectionStatus } from './ssh-types'

export type ExecutionHostHealth =
  | 'local'
  | 'available'
  | 'connecting'
  | 'blocked'
  | 'disconnected'
  | 'error'

/** An SSH host's health; a target with no lifecycle state has never connected. */
export function getSshConnectionHealth(
  status: SshConnectionStatus | undefined
): ExecutionHostHealth {
  switch (status) {
    case 'connected':
      return 'available'
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return 'connecting'
    case 'auth-failed':
    case 'error':
    case 'reconnection-failed':
      return 'error'
    case 'disconnected':
    case undefined:
      return 'disconnected'
  }
}

export function getExecutionHostHealthLabel(health: ExecutionHostHealth): string {
  switch (health) {
    case 'local':
      return 'Local'
    case 'available':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'blocked':
      return 'Update needed'
    case 'disconnected':
      return 'Disconnected'
    case 'error':
      return 'Needs attention'
  }
}
