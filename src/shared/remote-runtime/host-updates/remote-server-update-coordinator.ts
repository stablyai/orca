import { compareAppVersions, isValidAppVersion } from '../../app-lifecycle/identity/app-version'
import { REMOTE_SERVER_UPDATE_CAPABILITY } from '../host-catalog/remote-server-update'
import {
  getOrcadSshDeployment,
  type PublicKnownRuntimeEnvironment
} from '../host-catalog/runtime-environments'
import type { RuntimeStatus } from '../session-graph/runtime-session-contracts'
import type { UpdateCheckOptions } from '../../updater/update-status-types'
import {
  DEFAULT_REMOTE_SERVER_UPDATE_TIMING,
  describeRemoteServerUpdateError,
  type RemoteServerUpdateEntry,
  type RemoteServerUpdateRunOptions,
  type RemoteServerUpdateTiming,
  type RemoteServerUpdateTransport
} from './remote-server-update-entry'
import {
  downloadRemoteServerUpdate,
  installRemoteServerUpdate
} from './remote-server-update-stages'
import { getRemoteServerNewerThanClientVersion } from './remote-server-version-skew'
import { pollRemoteServerUpdater } from './remote-server-updater-polling'

export type {
  RemoteServerUpdateEntry,
  RemoteServerUpdatePhase,
  RemoteServerUpdateRunOptions,
  RemoteServerUpdateTiming,
  RemoteServerUpdateTransport
} from './remote-server-update-entry'
export { DEFAULT_REMOTE_SERVER_UPDATE_TIMING } from './remote-server-update-entry'

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
        error: describeRemoteServerUpdateError(transport, error)
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
  const downloaded = await downloadRemoteServerUpdate(entry, transport, onProgress, options)
  if (downloaded.phase !== 'downloaded') {
    return downloaded
  }
  return installRemoteServerUpdate(downloaded, transport, onProgress, options)
}
