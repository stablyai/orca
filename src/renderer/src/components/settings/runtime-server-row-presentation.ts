import { translate } from '@/i18n/i18n'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import {
  getRuntimeServerConnectionLabel,
  getRuntimeServerDotClass,
  type RuntimeServerConnectionState
} from './runtime-environment-host-details'

export type RuntimeServerStatusIndicator = {
  label: string
  labelClassName: string
  dotClassName: string
}

export function getRuntimeServerStatusIndicator(
  connectionState: RuntimeServerConnectionState,
  accessRevoked: boolean
): RuntimeServerStatusIndicator {
  // Why: the host answered and refused our token, so "Disconnected" would misstate a reachable host.
  if (accessRevoked) {
    return {
      label: translate(
        'auto.components.settings.RuntimeEnvironmentsPane.serverAccessRevoked',
        'Access revoked'
      ),
      labelClassName: 'text-destructive',
      dotClassName: 'bg-destructive'
    }
  }
  return {
    label: getRuntimeServerConnectionLabel(connectionState),
    labelClassName: 'text-muted-foreground',
    dotClassName: getRuntimeServerDotClass(connectionState)
  }
}

export type RuntimeServerVersionFooter = {
  text: string
  showUpdateStatus: boolean
}

export function getRuntimeServerVersionFooter(
  entry: RemoteServerUpdateEntry,
  options: { accessRevoked: boolean; lastKnownVersion: string | null | undefined }
): RuntimeServerVersionFooter | null {
  // Why: a revoked host refuses the version probe; "Offline" would contradict the revoked verdict.
  if (options.accessRevoked && entry.phase === 'offline') {
    const lastKnownVersion = options.lastKnownVersion?.trim()
    return lastKnownVersion
      ? {
          text: translate(
            'auto.components.settings.RuntimeEnvironmentsPane.orcaVersionLastSeen',
            'Orca v{{value0}} (last seen)',
            { value0: lastKnownVersion }
          ),
          showUpdateStatus: false
        }
      : null
  }
  return {
    text: entry.currentVersion
      ? translate(
          'auto.components.settings.RuntimeEnvironmentsPane.orcaVersion',
          'Orca v{{value0}}',
          {
            value0: entry.currentVersion
          }
        )
      : translate(
          'auto.components.settings.RuntimeEnvironmentsPane.versionUnavailable',
          'Orca version unavailable'
        ),
    showUpdateStatus: true
  }
}
