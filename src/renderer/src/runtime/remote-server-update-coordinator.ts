import {
  compareAppVersions,
  isPerfPrereleaseAppVersion,
  isPrereleaseAppVersion,
  isValidAppVersion
} from '../../../shared/app-version'
import { REMOTE_SERVER_UPDATE_CAPABILITY } from '../../../shared/remote-server-update'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot,
  RemoteServerUpdateSupport
} from '../../../shared/remote-server-update'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { UpdateCheckOptions } from '../../../shared/types'
import { remoteServerUpdateErrorMessage } from './remote-server-update-errors'
import { pollRemoteServerUpdater } from './remote-server-updater-polling'

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
}

export type RemoteServerUpdateTransport = {
  getRuntimeStatus: (environmentId: string, timeoutMs?: number) => Promise<RuntimeStatus>
  getUpdaterStatus: (environmentId: string) => Promise<RemoteServerUpdaterSnapshot>
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
    error: null
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
  const statusFields = {
    currentVersion,
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
      targetVersion: versionComparable ? clientVersion : null
    }
  }

  if (checkOptions) {
    try {
      const first = await transport.check(environment.id, checkOptions)
      const checked =
        first.status.state === 'available' || first.status.state === 'not-available'
          ? first
          : await pollRemoteServerUpdater(
              environment.id,
              transport,
              timing,
              (snapshot) =>
                snapshot.status.state === 'available' || snapshot.status.state === 'not-available',
              () => undefined
            )
      if (checked.status.state === 'available') {
        return {
          ...base,
          ...statusFields,
          phase: 'available',
          targetVersion: checked.status.version
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
    targetVersion: clientVersion
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
    await transport.check(entry.environmentId, options.checkOptions ?? inferredCheckOptions)
    const available = await pollRemoteServerUpdater(
      entry.environmentId,
      transport,
      timing,
      (snapshot) =>
        snapshot.status.state === 'available' || snapshot.status.state === 'not-available',
      () => undefined
    )
    if (available.status.state === 'not-available') {
      const status = await transport.getRuntimeStatus(entry.environmentId, 10_000)
      const currentVersion = status.appVersion?.trim() ?? ''
      const reachedTarget =
        entry.targetVersion !== null &&
        isValidAppVersion(currentVersion) &&
        isValidAppVersion(entry.targetVersion) &&
        compareAppVersions(currentVersion, entry.targetVersion) >= 0
      if (!reachedTarget) {
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
    if (available.status.state !== 'available') {
      throw new Error('remote_update_status_unavailable')
    }

    next = {
      ...next,
      phase: 'downloading',
      targetVersion: available.status.version,
      progress: 0
    }
    onProgress(next)
    await transport.download(entry.environmentId)
    const downloaded = await pollRemoteServerUpdater(
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
    if (downloaded.status.state !== 'downloaded') {
      throw new Error('remote_update_download_incomplete')
    }

    const install = await transport.install(entry.environmentId)
    next = {
      ...next,
      phase: 'restarting',
      targetVersion: install.targetVersion,
      progress: null
    }
    onProgress(next)

    const now = transport.now ?? Date.now
    const reconnectDeadline = now() + timing.reconnectTimeoutMs
    while (now() < reconnectDeadline) {
      try {
        const status = await transport.getRuntimeStatus(entry.environmentId, 10_000)
        const version = status.appVersion?.trim() ?? ''
        const reachedTarget =
          isValidAppVersion(version) &&
          isValidAppVersion(install.targetVersion) &&
          compareAppVersions(version, install.targetVersion) >= 0
        if (status.runtimeId !== install.runtimeId && reachedTarget) {
          next = {
            ...next,
            phase: 'updated',
            currentVersion: version,
            runtimeId: status.runtimeId,
            liveTabCount: status.liveTabCount,
            liveLeafCount: status.liveLeafCount
          }
          onProgress(next)
          return next
        }
      } catch {
        // A refused connection is expected while the server process is being replaced.
      }
      await transport.wait(timing.pollIntervalMs)
    }
    throw new Error('remote_update_reconnect_timeout')
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
