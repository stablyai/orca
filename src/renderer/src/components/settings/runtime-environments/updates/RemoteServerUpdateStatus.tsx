import type React from 'react'
import { AlertCircle, CheckCircle2, Download, Loader2, ServerOff, Wrench } from 'lucide-react'
import type {
  RemoteServerUpdateEntry,
  RemoteServerUpdatePhase
} from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

export function getRemoteServerUpdatePhaseLabel(
  phase: RemoteServerUpdatePhase,
  t: Translate = translate
): string {
  switch (phase) {
    case 'checking':
      return t('auto.components.settings.RemoteServerUpdateStatus.checking', 'Checking…')
    case 'available':
      return t('auto.components.settings.RemoteServerUpdateStatus.available', 'Update available')
    case 'current':
      return t('auto.components.settings.RemoteServerUpdateStatus.current', 'Up to date')
    case 'manual':
      return t('auto.components.settings.RemoteServerUpdateStatus.manual', 'Manual update')
    case 'offline':
      return t('auto.components.settings.RemoteServerUpdateStatus.offline', 'Offline')
    case 'queued':
      return t('auto.components.settings.RemoteServerUpdateStatus.queued', 'Queued')
    case 'checking-update':
      return t(
        'auto.components.settings.RemoteServerUpdateStatus.checkingUpdate',
        'Checking update…'
      )
    case 'downloading':
      return t('auto.components.settings.RemoteServerUpdateStatus.downloading', 'Downloading…')
    case 'restarting':
      return t('auto.components.settings.RemoteServerUpdateStatus.restarting', 'Restarting…')
    case 'updated':
      return t('auto.components.settings.RemoteServerUpdateStatus.updated', 'Updated')
    case 'failed':
      return t('auto.components.settings.RemoteServerUpdateStatus.failed', 'Update failed')
  }
}

function phaseIcon(phase: RemoteServerUpdatePhase): React.JSX.Element {
  switch (phase) {
    case 'checking':
    case 'queued':
    case 'checking-update':
    case 'restarting':
      return <Loader2 className="animate-spin" />
    case 'downloading':
      return <Download />
    case 'current':
    case 'updated':
      return <CheckCircle2 />
    case 'manual':
      return <Wrench />
    case 'offline':
      return <ServerOff />
    case 'failed':
      return <AlertCircle />
    case 'available':
      return <Download />
  }
}

export function RemoteServerUpdateStatus({
  entry,
  compact = false
}: {
  entry: RemoteServerUpdateEntry
  compact?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const progress =
    entry.phase === 'downloading' && entry.progress !== null
      ? ` ${Math.round(entry.progress)}%`
      : ''
  return (
    <Badge
      variant={entry.phase === 'failed' ? 'destructive' : 'outline'}
      className={compact ? 'px-1.5 text-[11px]' : undefined}
    >
      {phaseIcon(entry.phase)}
      {getRemoteServerUpdatePhaseLabel(entry.phase, t)}
      {progress}
    </Badge>
  )
}

export function getRemoteServerManualUpdateHelp(
  entry: RemoteServerUpdateEntry,
  t: Translate = translate
): string {
  if (entry.managedOverSsh) {
    return t(
      'auto.components.settings.RemoteServerUpdateStatus.managedOverSshHelp',
      'This desktop updates this server over SSH. Use Update on its row in Remote Orca Servers.'
    )
  }
  if (entry.support?.reason === 'manual-service-update-required') {
    return t(
      'auto.components.settings.RemoteServerUpdateStatus.serviceManagerHelp',
      'Update Orca on the server host — through its system package manager if it was installed from a .deb or .rpm, otherwise through the service manager that starts it.'
    )
  }
  if (entry.support?.reason === 'unpackaged-build') {
    return t(
      'auto.components.settings.RemoteServerUpdateStatus.unpackedHelp',
      'Development builds must be updated from their source checkout.'
    )
  }
  return t(
    'auto.components.settings.RemoteServerUpdateStatus.legacyHelp',
    'Remote updates are unavailable for this server. Update Orca on the server host.'
  )
}
