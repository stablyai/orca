import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

export type SshTargetBusyAction = 'terminate' | 'reset' | 'remove'

export function isSshTargetConnecting(status: SshConnectionStatus): boolean {
  return isConnectingSshStatus(status)
}

export function shouldClearPendingSshReset({
  pendingTargetId,
  pendingResetIsBusy,
  connectionStatus
}: {
  pendingTargetId: string | null
  pendingResetIsBusy: boolean
  connectionStatus: SshConnectionStatus
}): boolean {
  return pendingTargetId !== null && !pendingResetIsBusy && isSshTargetConnecting(connectionStatus)
}
