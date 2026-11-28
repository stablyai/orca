import {
  hasReachedAppVersion,
  isPerfPrereleaseAppVersion,
  isPrereleaseAppVersion
} from '../../app-lifecycle/identity/app-version'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../host-catalog/remote-server-update'
import type { RuntimeStatus } from '../session-graph/runtime-session-contracts'
import {
  DEFAULT_REMOTE_SERVER_UPDATE_TIMING,
  describeRemoteServerUpdateError,
  type RemoteServerUpdateEntry,
  type RemoteServerUpdateRunOptions,
  type RemoteServerUpdateTiming,
  type RemoteServerUpdateTransport
} from './remote-server-update-entry'
import {
  waitForReplacementRuntime,
  type RemoteServerRuntimeIdentity
} from './remote-server-restart-wait'
import { pollRemoteServerUpdater } from './remote-server-updater-polling'

/** What the stages need: an id-and-version status read is enough to see the replacement process. */
export type RemoteServerUpdateStageTransport = Omit<
  RemoteServerUpdateTransport,
  'getRuntimeStatus'
> & {
  getRuntimeStatus: (
    environmentId: string,
    timeoutMs?: number,
    options?: { force?: true }
  ) => Promise<
    RemoteServerRuntimeIdentity & Partial<Pick<RuntimeStatus, 'liveTabCount' | 'liveLeafCount'>>
  >
}

const failedEntry = (
  entry: RemoteServerUpdateEntry,
  transport: RemoteServerUpdateStageTransport,
  error: unknown
): RemoteServerUpdateEntry => ({
  ...entry,
  phase: 'failed',
  progress: null,
  error: describeRemoteServerUpdateError(transport, error)
})

/**
 * Brings the host's update to downloaded, ready for a restart only the caller asks for. `from` is
 * the updater as the caller last read it: an offered, downloading or downloaded update is followed
 * from there instead of checking again, which could replace the version the user is looking at.
 */
export async function downloadRemoteServerUpdate(
  entry: RemoteServerUpdateEntry,
  transport: RemoteServerUpdateStageTransport,
  onProgress: (entry: RemoteServerUpdateEntry) => void,
  options: RemoteServerUpdateRunOptions & { from?: RemoteServerUpdaterSnapshot } = {}
): Promise<RemoteServerUpdateEntry> {
  const timing = options.timing ?? DEFAULT_REMOTE_SERVER_UPDATE_TIMING
  let next: RemoteServerUpdateEntry = {
    ...entry,
    phase: 'checking-update',
    progress: null,
    error: null
  }
  try {
    let from = options.from
    const resumable =
      from?.status.state === 'available' ||
      from?.status.state === 'downloading' ||
      from?.status.state === 'downloaded'
    if (!from || !resumable) {
      onProgress(next)
      const inferredCheckOptions = {
        includePrerelease:
          entry.targetVersion !== null && isPrereleaseAppVersion(entry.targetVersion),
        includePerfPrerelease:
          entry.targetVersion !== null && isPerfPrereleaseAppVersion(entry.targetVersion)
      }
      await transport.check(entry.environmentId, options.checkOptions ?? inferredCheckOptions)
      from = await pollRemoteServerUpdater(
        entry.environmentId,
        transport,
        timing,
        (snapshot) =>
          snapshot.status.state === 'available' || snapshot.status.state === 'not-available',
        () => undefined
      )
      if (from.status.state === 'not-available') {
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
      if (from.status.state !== 'available') {
        throw new Error('remote_update_status_unavailable')
      }
    }
    const offered = from.status
    if (offered.state === 'downloaded') {
      return { ...next, phase: 'downloaded', targetVersion: offered.version }
    }
    if (offered.state !== 'available' && offered.state !== 'downloading') {
      throw new Error('remote_update_status_unavailable')
    }
    next = {
      ...next,
      phase: 'downloading',
      targetVersion: offered.version,
      progress: offered.state === 'downloading' ? offered.percent : 0
    }
    onProgress(next)
    if (offered.state === 'available') {
      await transport.download(entry.environmentId)
    }
    const downloaded = await pollRemoteServerUpdater(
      entry.environmentId,
      transport,
      timing,
      (snapshot) => snapshot.status.state === 'downloaded',
      (snapshot) => {
        // A stalled download is polled every tick; only a new percent is news.
        if (snapshot.status.state === 'downloading' && snapshot.status.percent !== next.progress) {
          next = { ...next, progress: snapshot.status.percent }
          onProgress(next)
        }
      }
    )
    if (downloaded.status.state !== 'downloaded') {
      throw new Error('remote_update_download_incomplete')
    }
    return {
      ...next,
      phase: 'downloaded',
      targetVersion: downloaded.status.version,
      progress: null
    }
  } catch (error) {
    next = failedEntry(next, transport, error)
    onProgress(next)
    return next
  }
}

/**
 * Restarts the host onto its downloaded update and waits for the replacement process. With
 * `install` it only waits again, for a restart already asked for (e.g. after "hasn't come back").
 */
export async function installRemoteServerUpdate(
  entry: RemoteServerUpdateEntry,
  transport: RemoteServerUpdateStageTransport,
  onProgress: (entry: RemoteServerUpdateEntry) => void,
  options: { timing?: RemoteServerUpdateTiming; install?: RemoteServerUpdateInstallResult } = {}
): Promise<RemoteServerUpdateEntry> {
  const timing = options.timing ?? DEFAULT_REMOTE_SERVER_UPDATE_TIMING
  let next: RemoteServerUpdateEntry = { ...entry, error: null }
  try {
    const install = options.install ?? (await transport.install(entry.environmentId))
    next = {
      ...next,
      phase: 'restarting',
      targetVersion: install.targetVersion,
      progress: null,
      install
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
      liveTabCount: replacement.liveTabCount ?? next.liveTabCount,
      liveLeafCount: replacement.liveLeafCount ?? next.liveLeafCount
    }
    onProgress(next)
    return next
  } catch (error) {
    next = failedEntry(next, transport, error)
    onProgress(next)
    return next
  }
}
