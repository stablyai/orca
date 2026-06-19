import type { SshConnectionStatus } from '../../../shared/ssh-types'

// Short, human-readable label for an SSH connection status, used in task-source
// availability summaries.
export function getSshStatusLabel(status: SshConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'connected'
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return 'connecting'
    case 'auth-failed':
      return 'auth needed'
    case 'reconnection-failed':
    case 'error':
      return 'connection issue'
    case 'disconnected':
      return 'disconnected'
  }
}
