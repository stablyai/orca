import type { SshConnectionStatus, SshReadinessState } from '../../../../shared/ssh-types'

/** Background class for an SSH status dot. Lives outside the cards so both the
 *  connection dot and the readiness dot read one palette. */
export function statusColor(status: SshConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500'
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return 'bg-yellow-500'
    case 'auth-failed':
    case 'reconnection-failed':
    case 'error':
      return 'bg-red-500'
    case 'disconnected':
      return 'bg-muted-foreground/40'
  }
}

/** Readiness reuses the connection palette: ok = connected, miss = error, unknown = neutral. */
export function readinessStatusColor(state: SshReadinessState): string {
  switch (state) {
    case 'ok':
      return statusColor('connected')
    case 'miss':
      return statusColor('error')
    case 'unknown':
      return statusColor('disconnected')
  }
}
