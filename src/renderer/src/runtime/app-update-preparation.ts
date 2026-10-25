import { getVersionChannel } from '../../../shared/release-channel'
import { remoteServerUpdateTransportForRevision } from './remote-server-update-transport'
import { isPerfPrereleaseAppVersion, isPrereleaseAppVersion } from '../../../shared/app-version'
import { isListedRemoteServer } from '../../../shared/runtime-environments'
import type { UpdateStatus } from '../../../shared/update-status-types'
import {
  inspectRemoteServerUpdate,
  type RemoteServerUpdateEntry,
  type RemoteServerUpdateTransport
} from './remote-server-update-coordinator'

export async function discoverAppUpdateRemoteCandidates(
  version: string
): Promise<RemoteServerUpdateEntry[]> {
  const environments = (await window.api.runtimeEnvironments.list()).filter(isListedRemoteServer)
  const options = {
    includePrerelease: isPrereleaseAppVersion(version),
    includePerfPrerelease: isPerfPrereleaseAppVersion(version)
  }
  const entries = await Promise.all(
    environments.map((environment) =>
      inspectRemoteServerUpdate(
        environment,
        version,
        remoteServerUpdateTransportForRevision(
          environment.pairingRevision ?? environment.createdAt
        ),
        options
      )
    )
  )
  return entries.filter((entry) => entry.phase === 'available')
}

export async function downloadAppUpdate(
  targetVersion: string,
  getStatus: () => UpdateStatus,
  transport: Pick<RemoteServerUpdateTransport, 'wait'>
): Promise<void> {
  const initial = getStatus()
  if (initial.state === 'downloaded' && initial.version === targetVersion) {
    return
  }
  if (initial.state !== 'available' || initial.version !== targetVersion) {
    const channel = getVersionChannel(targetVersion)
    if (!channel) {
      throw new Error('The saved app update has an unknown release channel.')
    }
    const result = await window.api.updater.listBuilds(channel)
    const build = result.ok
      ? result.builds.find((candidate) => candidate.version === targetVersion)
      : undefined
    if (!build) {
      throw new Error('The saved app update is no longer available. Check for updates again.')
    }
    await window.api.updater.check({ channel, targetTag: build.tag })
    const checkDeadline = Date.now() + 60_000
    while (Date.now() < checkDeadline) {
      const checked = getStatus()
      if (checked.state === 'available' && checked.version === targetVersion) {
        break
      }
      if (checked.state === 'downloaded' && checked.version === targetVersion) {
        return
      }
      if (checked.state === 'error' || checked.state === 'not-available') {
        throw new Error('Could not prepare the saved app update. Check for updates again.')
      }
      await transport.wait(250)
    }
    const checked = getStatus()
    if (checked.state !== 'available' || checked.version !== targetVersion) {
      throw new Error('Timed out checking the saved app update.')
    }
  }
  await window.api.updater.download()
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    const local = getStatus()
    if (local.state === 'error') {
      throw new Error(local.message)
    }
    if (local.state === 'downloaded' && local.version === targetVersion) {
      return
    }
    await transport.wait(250)
  }
  throw new Error('Timed out downloading the local Orca update.')
}
