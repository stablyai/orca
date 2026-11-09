import { toast } from 'sonner'
import { toastSshConnectFailure } from '@/ssh/ssh-connect-failure-toast'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { RemoteHostStatusRow } from './RemoteHostStatusRow'
import type { HostRecoveryObservation } from './use-remote-host-menu-state'
import { useAppStore } from '../../store'
import { STATUS_LABELS } from '../settings/ssh/targets/SshTargetCard'
import { sshConnectVerb } from '@/ssh/ssh-connect-verb'
import {
  beginSshConnect,
  endSshConnect,
  isSshConnectInFlight,
  useSshConnectInFlight
} from '@/ssh/ssh-connect-in-flight'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

export async function connectSshTargetFromStatusMenu(
  targetId: string,
  signal?: AbortSignal
): Promise<void> {
  if (isSshConnectInFlight(targetId)) {
    return
  }
  beginSshConnect(targetId)
  try {
    await window.api.ssh.connect({ targetId })
    if (!signal?.aborted) {
      useAppStore.getState().recordFeatureInteraction('ssh')
    }
  } catch (err) {
    if (signal?.aborted) {
      return
    }
    toastSshConnectFailure(
      targetId,
      err,
      translate('auto.components.status.bar.SshStatusSegment.2c29e2de68', 'Connection failed')
    )
  } finally {
    endSshConnect(targetId)
  }
}

export async function disconnectSshTargetFromStatusMenu(targetId: string): Promise<void> {
  try {
    await window.api.ssh.disconnect({ targetId })
    useAppStore.getState().recordFeatureInteraction('ssh')
  } catch (err) {
    toast.error(
      err instanceof Error
        ? err.message
        : translate('auto.components.status.bar.SshStatusSegment.bf07aee59e', 'Disconnect failed')
    )
  }
}

export function SshTargetStatusRow({
  targetId,
  label,
  kind,
  status,
  error,
  pending,
  recovery,
  now,
  onConnect,
  onDisconnect
}: {
  targetId: string
  label: string
  kind?: string
  status: SshConnectionStatus
  error?: string | null
  pending: boolean
  recovery?: HostRecoveryObservation
  now: number
  onConnect: () => Promise<void>
  onDisconnect: () => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  pending = pending && status !== 'connected'
  const connectInFlight = useSshConnectInFlight(targetId)
  const transient =
    pending || status === 'connecting' || status === 'deploying-relay' || status === 'reconnecting'
  const failed = !transient && status !== 'connected' && status !== 'disconnected'
  const tone = transient
    ? 'busy'
    : failed
      ? 'error'
      : status === 'connected'
        ? 'connected'
        : 'offline'
  const stateWord =
    transient && recovery?.attempt
      ? t(
          'auto.components.status.bar.RemoteHostStatusRow.reconnecting_attempt',
          'Reconnecting (attempt {{attempt}})',
          { attempt: String(recovery.attempt) }
        )
      : transient
        ? t('auto.components.status.bar.SshStatusSegment.runtime_checking', 'Checking')
        : STATUS_LABELS[status]
  const actionKind = transient || status === 'connected' ? 'disconnect' : 'connect'
  return (
    <RemoteHostStatusRow
      label={label}
      kind={kind}
      tone={tone}
      status={stateWord}
      actionKind={actionKind}
      actionLabel={
        transient
          ? t('auto.components.status.bar.RemoteHostStatusRow.stop', 'Stop')
          : status === 'connected'
            ? t('auto.components.status.bar.SshStatusSegment.59b553e2aa', 'Disconnect')
            : sshConnectVerb(status, t)
      }
      onAction={actionKind === 'disconnect' ? onDisconnect : onConnect}
      disabled={actionKind === 'connect' && connectInFlight}
      errorSentence={
        failed
          ? status === 'auth-failed'
            ? t(
                'auto.components.status.bar.RemoteHostStatusRow.ssh_sign_in_failed',
                'Couldn’t sign in to this host; check its SSH credentials.'
              )
            : t(
                'auto.components.status.bar.RemoteHostStatusRow.ssh_connect_failed',
                'Couldn’t connect to this host; check its SSH settings and try again.'
              )
          : undefined
      }
      rawDetail={error ?? undefined}
      recovery={recovery}
      now={now}
      onRetry={onConnect}
      onDisconnect={onDisconnect}
    />
  )
}
