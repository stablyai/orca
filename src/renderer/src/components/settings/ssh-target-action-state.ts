import type { SshConnectionStatus } from '../../../../shared/ssh-types'

export type SshTargetBusyAction = 'terminate' | 'reset' | 'remove'

const SSH_TARGET_CONNECTING_STATUSES: ReadonlySet<SshConnectionStatus> = new Set([
  'connecting',
  'deploying-relay',
  'reconnecting'
])

export function isSshTargetConnecting(status: SshConnectionStatus): boolean {
  return SSH_TARGET_CONNECTING_STATUSES.has(status)
}
