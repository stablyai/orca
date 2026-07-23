import type React from 'react'
import { AlertCircle, CheckCircle2, Download, Loader2, ServerOff, Wrench } from 'lucide-react'
import type {
  RemoteServerUpdateEntry,
  RemoteServerUpdatePhase
} from '@/runtime/remote-server-update-coordinator'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'

export function getRemoteServerUpdatePhaseLabel(phase: RemoteServerUpdatePhase): string {
  switch (phase) {
    case 'checking':
      return translate('auto.components.settings.RemoteServerUpdateStatus.checking', 'Checking…')
    case 'available':
      return translate(
        'auto.components.settings.RemoteServerUpdateStatus.available',
        'Update available'
      )
    case 'current':
      return translate('auto.components.settings.RemoteServerUpdateStatus.current', 'Up to date')
    case 'manual':
      return translate('auto.components.settings.RemoteServerUpdateStatus.manual', 'Manual update')
    case 'offline':
      return translate('auto.components.settings.RemoteServerUpdateStatus.offline', 'Offline')
    case 'queued':
      return translate('auto.components.settings.RemoteServerUpdateStatus.queued', 'Queued')
    case 'checking-update':
      return translate(
        'auto.components.settings.RemoteServerUpdateStatus.checkingUpdate',
        'Checking update…'
      )
    case 'downloading':
      return translate(
        'auto.components.settings.RemoteServerUpdateStatus.downloading',
        'Downloading…'
      )
    case 'restarting':
      return translate(
        'auto.components.settings.RemoteServerUpdateStatus.restarting',
        'Restarting…'
      )
    case 'updated':
      return translate('auto.components.settings.RemoteServerUpdateStatus.updated', 'Updated')
    case 'failed':
      return translate('auto.components.settings.RemoteServerUpdateStatus.failed', 'Update failed')
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
      {getRemoteServerUpdatePhaseLabel(entry.phase)}
      {progress}
    </Badge>
  )
}

export function getRemoteServerManualUpdateHelp(entry: RemoteServerUpdateEntry): string {
  if (entry.support?.reason === 'manual-service-update-required') {
    return translate(
      'auto.components.settings.RemoteServerUpdateStatus.serviceManagerHelp',
      'Update Orca through the service manager that starts this server.'
    )
  }
  if (entry.support?.reason === 'unpackaged-build') {
    return translate(
      'auto.components.settings.RemoteServerUpdateStatus.unpackedHelp',
      'Development builds must be updated from their source checkout.'
    )
  }
  return translate(
    'auto.components.settings.RemoteServerUpdateStatus.legacyHelp',
    'Update this server manually once to enable remote updates.'
  )
}
