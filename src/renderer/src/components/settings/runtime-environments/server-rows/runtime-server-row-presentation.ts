import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import '@/runtime/hosts/connections/runtime-host-connection-state'
import {
  isConnectedRuntimeHostState,
  type RuntimeHostConnectionState as RuntimeServerConnectionState
} from '../../../../../../shared/remote-runtime/host-status/runtime-host-connection-state'
import type {
  RemoteServerUpdateEntry,
  RemoteServerUpdatePhase
} from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { getRuntimeServerConnectionLabel } from '../catalog/runtime-environment-host-details'

import { getRemoteServerUpdatePhaseLabel } from '../updates/RemoteServerUpdateStatus'
import type { ServerRowStatus } from '../../host-rows/ServerListRow'

const UPDATING_PHASES: ReadonlySet<RemoteServerUpdatePhase> = new Set([
  'queued',
  'checking-update',
  'downloading',
  'restarting'
])

export function isRemoteServerUpdateInFlight(entry: RemoteServerUpdateEntry | undefined): boolean {
  return entry !== undefined && UPDATING_PHASES.has(entry.phase)
}

export type RuntimeServerStatusInput = {
  connectionState: RuntimeServerConnectionState
  accessRevoked: boolean
  compatibilityBlocked: boolean
  /** The latest probe failed with an error rather than being a user disconnect. */
  probeFailed: boolean
  connecting: boolean
  disconnecting: boolean
  remoteUpdate: RemoteServerUpdateEntry | undefined
  /** A managed server whose loaded status has no active version. */
  managedNotRunning?: boolean
}

export function getRuntimeServerStatusIndicator(
  input: RuntimeServerStatusInput,
  t: Translate = translate
): ServerRowStatus {
  // Token refusal proves reachability; Disconnected would misdescribe the host.
  if (input.accessRevoked) {
    return {
      label: t(
        'auto.components.settings.RuntimeEnvironmentsPane.serverAccessRevoked',
        'Access revoked'
      ),
      tone: 'destructive'
    }
  }
  if (input.remoteUpdate && isRemoteServerUpdateInFlight(input.remoteUpdate)) {
    return {
      label: getRemoteServerUpdatePhaseLabel(input.remoteUpdate.phase, t),
      tone: 'muted',
      busy: true
    }
  }
  if (input.connecting) {
    return {
      label: t('auto.components.settings.serverList.connecting', 'Connecting…'),
      tone: 'muted',
      busy: true
    }
  }
  if (input.disconnecting) {
    return {
      label: t('auto.components.settings.serverList.disconnecting', 'Disconnecting…'),
      tone: 'muted',
      busy: true
    }
  }
  if (input.compatibilityBlocked) {
    return {
      label: t('auto.components.settings.serverList.needsUpdate', 'Needs update'),
      tone: 'destructive'
    }
  }
  // Revoked/updating/connecting/incompatible states take priority over Not running.
  if (input.managedNotRunning && !isConnectedRuntimeHostState(input.connectionState)) {
    return {
      label: t('auto.components.settings.managedServers.row.notRunning', 'Not running'),
      tone: 'muted'
    }
  }
  const label = getRuntimeServerConnectionLabel(input.connectionState, t)
  switch (input.connectionState) {
    case 'connected':
      return { label, tone: 'success' }
    case 'checking':
      return { label, tone: 'muted', busy: true }
    case 'reconnecting':
      return { label, tone: 'warning', busy: true }
    case 'runtime-unavailable':
    case 'workspace-window-closed':
      return { label, tone: 'warning' }
    case 'disconnected':
      // Label silent probes Unreachable; they cannot establish that the host is down.
      return input.probeFailed
        ? {
            label: t('auto.components.settings.serverList.unreachable', 'Unreachable'),
            tone: 'muted'
          }
        : { label, tone: 'muted' }
  }
}

/** The version part of the meta line; null when no version was ever verified. */
export function getRuntimeServerVersionText(
  entry: RemoteServerUpdateEntry | undefined,
  lastKnownVersion: string | null | undefined,
  t: Translate = translate
): string | null {
  const version = entry?.currentVersion?.trim() || lastKnownVersion?.trim()
  return version
    ? t('auto.components.settings.serverList.version', 'v{{version}}', {
        version
      })
    : null
}

export function getRuntimeServerAvailableUpdateText(
  entry: RemoteServerUpdateEntry | undefined,
  t: Translate = translate
): string | null {
  if (entry?.phase !== 'available') {
    return null
  }
  return entry.targetVersion
    ? t('auto.components.settings.serverList.updateAvailable', 'v{{version}} available', {
        version: entry.targetVersion
      })
    : t('auto.components.settings.RemoteServerUpdateStatus.available', 'Update available')
}

/** host:port of a ws:// endpoint; the raw string when it isn't a URL. */
export function formatRuntimeEndpointAddress(endpoint: string | undefined): string | null {
  if (!endpoint) {
    return null
  }
  try {
    return new URL(endpoint).host || endpoint
  } catch {
    return endpoint
  }
}
