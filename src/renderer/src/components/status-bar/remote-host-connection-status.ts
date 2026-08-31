import { translate } from '@/i18n/i18n'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'
import type { HostStatus } from '@/runtime/runtime-host-connection-state'
import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'

export function overallStatus(
  statuses: HostStatus[]
): 'connected' | 'partial' | 'disconnected' | 'connecting' {
  if (statuses.length === 0) {
    return 'disconnected'
  }
  if (statuses.every((s) => s === 'connected')) {
    return 'connected'
  }
  if (statuses.some((s) => s === 'connecting')) {
    return 'connecting'
  }
  if (statuses.some((s) => s === 'connected')) {
    return 'partial'
  }
  return 'disconnected'
}

export function overallDotColor(
  status: 'connected' | 'partial' | 'disconnected' | 'connecting',
  connectedCount: number
): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500'
    case 'partial':
      return connectedCount > 0 ? 'bg-emerald-500' : 'bg-muted-foreground/40'
    case 'connecting':
      return 'bg-yellow-500'
    case 'disconnected':
      return 'bg-muted-foreground/40'
  }
}

export function sshStatusForOverall(status: SshConnectionStatus): HostStatus {
  if (status === 'connected') {
    return 'connected'
  }
  return isConnectingSshStatus(status) ? 'connecting' : 'disconnected'
}

export function runtimeHostConnectionDetail(
  remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
): string | undefined {
  if (!remoteControl) {
    return undefined
  }
  if (
    remoteControl.state === 'awaiting_ready' ||
    remoteControl.state === 'awaiting_authenticated'
  ) {
    return undefined
  }
  if (remoteControl.state === 'reconnecting') {
    return translate(
      'auto.components.status.bar.SshStatusSegment.runtime_reconnect_attempt',
      'Attempt {{value0}}',
      { value0: String(remoteControl.reconnectAttempt + 1) }
    )
  }
  if (remoteControl.lastError) {
    return remoteControl.lastError
  }
  if (remoteControl.lastClose?.reason) {
    return translate(
      'auto.components.status.bar.SshStatusSegment.runtime_last_close_reason',
      'Closed: {{value0}}',
      { value0: remoteControl.lastClose.reason }
    )
  }
  // Why: pending-request / subscription counts are internal RPC plumbing (e.g. a
  // live browser screencast shows as "N streams"). They're noise in a user-facing
  // status row and make the line truncate — only surface actionable detail
  // (errors, close reasons, reconnect attempts) above.
  return undefined
}
