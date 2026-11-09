import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { RuntimeHostConnectionState } from '../../../../shared/remote-runtime/host-status/runtime-host-connection-state'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import type {
  RuntimeHostBlockedCopy,
  RuntimeHostBlockedRecovery
} from './remote-host-connection-status'
import { RemoteHostStatusRow } from './RemoteHostStatusRow'
import type { HostRecoveryObservation } from './use-remote-host-menu-state'

function runtimeStatusLabel(state: RuntimeHostConnectionState, t: Translate = translate): string {
  switch (state) {
    case 'connected':
      return t('auto.components.status.bar.SshStatusSegment.runtime_online', 'Connected')
    case 'runtime-unavailable':
      return t(
        'auto.components.status.bar.SshStatusSegment.runtime_unavailable_transport_up',
        'Orca unavailable'
      )
    case 'workspace-window-closed':
      return t(
        'auto.components.status.bar.SshStatusSegment.runtime_workspace_window_closed',
        'Workspace window closed'
      )
    case 'checking':
      return t('auto.components.status.bar.SshStatusSegment.runtime_checking', 'Checking')
    case 'reconnecting':
      return t('auto.components.status.bar.SshStatusSegment.runtime_reconnecting', 'Reconnecting')
    case 'disconnected':
      return t('auto.components.status.bar.SshStatusSegment.runtime_unavailable', 'Disconnected')
  }
}

export function RuntimeHostStatusRow({
  label,
  kind,
  state,
  diagnostics,
  blocked,
  pending,
  recovery,
  now,
  onConnect,
  onDisconnect,
  onRecover
}: {
  label: string
  kind?: string
  state: RuntimeHostConnectionState
  diagnostics?: RemoteRuntimeSharedConnectionDiagnostics | null
  blocked?: (RuntimeHostBlockedCopy & { recovery: RuntimeHostBlockedRecovery | null }) | null
  pending: boolean
  recovery?: HostRecoveryObservation
  now: number
  onConnect: () => Promise<void>
  onDisconnect: () => Promise<void>
  onRecover: () => void
}): React.JSX.Element {
  const t = useTranslate()
  pending = pending && state !== 'connected' && state !== 'workspace-window-closed'
  blocked = pending ? null : blocked
  const transient = pending || state === 'checking' || state === 'reconnecting'
  const error = Boolean(blocked || state === 'runtime-unavailable')
  const repairs = Boolean(blocked?.recovery)
  const tone = blocked
    ? 'error'
    : transient
      ? 'busy'
      : error
        ? 'error'
        : state === 'disconnected'
          ? 'offline'
          : 'connected'
  const status =
    blocked?.label ??
    (state === 'reconnecting' || (transient && recovery?.attempt)
      ? recovery?.attempt
        ? t(
            'auto.components.status.bar.RemoteHostStatusRow.reconnecting_attempt',
            'Reconnecting (attempt {{attempt}})',
            { attempt: String(recovery.attempt) }
          )
        : runtimeStatusLabel('reconnecting', t)
      : runtimeStatusLabel(pending ? 'checking' : state, t))
  const actionKind = repairs
    ? 'recover'
    : transient && !blocked
      ? 'disconnect'
      : error || state === 'disconnected'
        ? 'connect'
        : 'disconnect'
  const actionLabel = repairs
    ? blocked?.recovery === 'open-settings'
      ? t('auto.components.status.bar.RuntimeHostStatusRow.open_settings', 'Open settings…')
      : t('auto.components.status.bar.RuntimeHostStatusRow.repair', 'Re-pair…')
    : transient && !blocked
      ? t('auto.components.status.bar.RemoteHostStatusRow.stop', 'Stop')
      : error
        ? t('auto.ssh.sshConnectVerb.retry', 'Retry')
        : actionKind === 'connect'
          ? t('auto.components.status.bar.SshStatusSegment.63f36455cc', 'Connect')
          : t('auto.components.status.bar.SshStatusSegment.59b553e2aa', 'Disconnect')
  return (
    <RemoteHostStatusRow
      label={label}
      kind={kind}
      tone={tone}
      status={status}
      actionLabel={actionLabel}
      actionKind={actionKind}
      onAction={repairs ? onRecover : actionKind === 'connect' ? onConnect : onDisconnect}
      errorSentence={
        blocked?.summary ??
        (!transient && state === 'runtime-unavailable'
          ? t(
              'auto.components.status.bar.RuntimeHostStatusRow.contact_note',
              'The host may still be running; only the Orca connection is unavailable.'
            )
          : undefined)
      }
      rawDetail={blocked?.detail ?? diagnostics?.lastError ?? diagnostics?.lastClose?.reason}
      recovery={recovery}
      now={now}
      onRetry={onConnect}
      onDisconnect={onDisconnect}
    />
  )
}
