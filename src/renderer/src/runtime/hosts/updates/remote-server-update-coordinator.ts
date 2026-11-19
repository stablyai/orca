import {
  compareAppVersions,
  hasReachedAppVersion,
  isPerfPrereleaseAppVersion,
  isPrereleaseAppVersion,
  isValidAppVersion
} from '../../../../../shared/app-lifecycle/identity/app-version'
import {
  REMOTE_SERVER_UPDATE_CAPABILITY,
  type RemoteServerUpdateInstallResult,
  type RemoteServerUpdaterSnapshot,
  type RemoteServerUpdateSupport
} from '../../../../../shared/remote-runtime/host-catalog/remote-server-update'

import {
  getOrcadSshDeployment,
  type PublicKnownRuntimeEnvironment
} from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { UpdateCheckOptions } from '../../../../../shared/updater/update-status-types'
import { waitForReplacementRuntime } from './remote-server-restart-wait'
import { getRemoteServerNewerThanClientVersion } from './remote-server-version-skew'
import { remoteServerUpdateErrorMessage } from './remote-server-update-errors'
import { checkRemoteServerUpdater, pollRemoteServerUpdater } from './remote-server-updater-polling'

export type RemoteServerUpdatePhase =
  | 'checking'
  | 'available'
  | 'current'
  | 'manual'
  | 'offline'
  | 'queued'
  | 'checking-update'
  | 'downloading'
  | 'restarting'
  | 'updated'
  | 'failed'

export type RemoteServerUpdateEntry = {
  environmentId: string
  name: string
  phase: RemoteServerUpdatePhase
  currentVersion: string | null
  targetVersion: string | null
  progress: number | null
  runtimeId: string | null
  liveTabCount: number
  liveLeafCount: number
  support: RemoteServerUpdateSupport | null
  error: string | null
  /** This desktop updates it over SSH, not through the host's own updater. */
  managedOverSsh?: boolean
  /** This app's version when it was compared; read through getRemoteServerNewerThanClientVersion. */
  clientVersion?: string | null
}

export type RemoteServerUpdateTransport = {
  getRuntimeStatus: (environmentId: string, timeoutMs?: number) => Promise<RuntimeStatus>
  getUpdaterStatus: (
    environmentId: string,
    timeoutMs?: number
  ) => Promise<RemoteServerUpdaterSnapshot>
  check: (
    environmentId: string,
    options: UpdateCheckOptions
  ) => Promise<RemoteServerUpdaterSnapshot>
  download: (environmentId: string) => Promise<RemoteServerUpdaterSnapshot>
  install: (environmentId: string) => Promise<RemoteServerUpdateInstallResult>
  wait: (milliseconds: number) => Promise<void>
  now?: () => number
}

export type RemoteServerUpdateTiming = {
  operationTimeoutMs: number
  reconnectTimeoutMs: number
  pollIntervalMs: number
}

export const DEFAULT_REMOTE_SERVER_UPDATE_TIMING: RemoteServerUpdateTiming = {
  operationTimeoutMs: 10 * 60 * 1000,
  reconnectTimeoutMs: 3 * 60 * 1000,
  pollIntervalMs: 500
}

export type RemoteServerUpdateRunOptions = {
  checkOptions?: UpdateCheckOptions
  timing?: RemoteServerUpdateTiming
}

export function checkingRemoteServerUpdateEntry(
  environment: PublicKnownRuntimeEnvironment
): RemoteServerUpdateEntry {
  return {
    environmentId: environment.id,
    name: environment.name,
    phase: 'checking',
    currentVersion: null,
    targetVersion: null,
    progress: null,
    runtimeId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    support: null,
    error: null,
    managedOverSsh: Boolean(getOrcadSshDeployment(environment))
  }
}

export async function inspectRemoteServerUpdate(
  environment: PublicKnownRuntimeEnvironment,
  clientVersion: string,
  transport: RemoteServerUpdateTransport,
  checkOptions?: UpdateCheckOptions,
  timing: RemoteServerUpdateTiming = DEFAULT_REMOTE_SERVER_UPDATE_TIMING
): Promise<RemoteServerUpdateEntry> {
  const base = checkingRemoteServerUpdateEntry(environment)
  let status: RuntimeStatus
  try {
    status = await transport.getRuntimeStatus(environment.id, 10_000)
  } catch (error) {
    return {
      ...base,
      phase: 'offline',
      error: error instanceof Error ? error.message : String(error)
    }
  }

  const currentVersion = status.appVersion?.trim() || null
  const supportsRemoteUpdate = status.capabilities?.includes(REMOTE_SERVER_UPDATE_CAPABILITY)
  const support = status.remoteUpdateSupport ?? null
  const versionComparable =
    currentVersion !== null && isValidAppVersion(currentVersion) && isValidAppVersion(clientVersion)
  const outdated = versionComparable && compareAppVersions(currentVersion, clientVersion) < 0
  // A newer server is not heading to this app's version; offering it would read as a downgrade.
  const comparedTarget =
    getRemoteServerNewerThanClientVersion({ currentVersion, clientVersion }) === null
      ? clientVersion
      : currentVersion
  const statusFields = {
    currentVersion,
    clientVersion,
    runtimeId: status.runtimeId,
    liveTabCount: status.liveTabCount,
    liveLeafCount: status.liveLeafCount,
    support
  }

  if (!supportsRemoteUpdate || !support?.automatic) {
    return {
      ...base,
      ...statusFields,
      phase: versionComparable && !outdated ? 'current' : 'manual',
      targetVersion: versionComparable ? comparedTarget : null
    }
  }

  if (checkOptions) {
    try {
      const { status: checked } = await checkRemoteServerUpdater(
        environment.id,
        transport,
        checkOptions,
        timing
      )
      if (
        checked.state === 'available' ||
        checked.state === 'downloading' ||
        checked.state === 'downloaded'
      ) {
        return {
          ...base,
          ...statusFields,
          phase: 'available',
          targetVersion: checked.version
        }
      }
      return {
        ...base,
        ...statusFields,
        phase: 'current',
        targetVersion: currentVersion
      }
    } catch (error) {
      return {
        ...base,
        ...statusFields,
        phase: 'failed',
        targetVersion: null,
        error: remoteServerUpdateErrorMessage(error)
      }
    }
  }

  return {
    ...base,
    ...statusFields,
    phase: versionComparable && !outdated ? 'current' : 'available',
    targetVersion: comparedTarget
  }
}

export async function runRemoteServerUpdate(
  entry: RemoteServerUpdateEntry,
  transport: RemoteServerUpdateTransport,
  onProgress: (entry: RemoteServerUpdateEntry) => void,
  options: RemoteServerUpdateRunOptions = {}
): Promise<RemoteServerUpdateEntry> {
  const timing = options.timing ?? DEFAULT_REMOTE_SERVER_UPDATE_TIMING
  let next: RemoteServerUpdateEntry = {
    ...entry,
    phase: 'checking-update',
    progress: null,
    error: null
  }
  onProgress(next)
  try {
    const inferredCheckOptions = {
      includePrerelease:
        entry.targetVersion !== null && isPrereleaseAppVersion(entry.targetVersion),
      includePerfPrerelease:
        entry.targetVersion !== null && isPerfPrereleaseAppVersion(entry.targetVersion)
    }
    const { status: offer } = await checkRemoteServerUpdater(
      entry.environmentId,
      transport,
      options.checkOptions ?? inferredCheckOptions,
      timing
    )
    if (offer.state === 'not-available') {
      const status = await transport.getRuntimeStatus(entry.environmentId, 10_000)
      const currentVersion = status.appVersion?.trim() ?? ''
      if (!hasReachedAppVersion(currentVersion, entry.targetVersion)) {
        throw new Error('remote_update_requested_version_unavailable')
      }
      next = {
        ...next,
        phase: 'current',
        currentVersion,
        runtimeId: status.runtimeId
      }
      onProgress(next)
      return next
    }
    if (offer.state === 'available' || offer.state === 'downloading') {
      next = {
        ...next,
        phase: 'downloading',
        targetVersion: offer.version,
        progress: offer.state === 'downloading' ? offer.percent : 0
      }
      onProgress(next)
      if (offer.state === 'available') {
        await transport.download(entry.environmentId)
      }
      await pollRemoteServerUpdater(
        entry.environmentId,
        transport,
        timing,
        (snapshot) => snapshot.status.state === 'downloaded',
        (snapshot) => {
          if (snapshot.status.state === 'downloading') {
            next = { ...next, progress: snapshot.status.percent }
            onProgress(next)
          }
        }
      )
    } else if (offer.state !== 'downloaded') {
      throw new Error('remote_update_status_unavailable')
    }

    const install = await transport.install(entry.environmentId)
    next = {
      ...next,
      phase: 'restarting',
      targetVersion: install.targetVersion,
      progress: null
    }
    onProgress(next)

    const replacement = await waitForReplacementRuntime(
      entry.environmentId,
      transport,
      install,
      timing
    )
    next = {
      ...next,
      phase: 'updated',
      currentVersion: replacement.appVersion?.trim() ?? '',
      runtimeId: replacement.runtimeId,
      liveTabCount: replacement.liveTabCount,
      liveLeafCount: replacement.liveLeafCount
    }
    onProgress(next)
    return next
  } catch (error) {
    next = {
      ...next,
      phase: 'failed',
      progress: null,
      error: remoteServerUpdateErrorMessage(error)
    }
    onProgress(next)
    return next
  }
}
