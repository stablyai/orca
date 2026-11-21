import {
  isPerfPrereleaseAppVersion,
  isPrereleaseAppVersion
} from '../../../../../shared/app-lifecycle/identity/app-version'
import {
  getVersionChannel,
  hasDedicatedReleaseRepo
} from '../../../../../shared/updater/release-channel'
import type { UpdateCheckOptions } from '../../../../../shared/updater/update-status-types'

/** True for hourly/daily/adhoc builds published to dedicated repos outside the server's updater feed. */
export function isDedicatedRepoVersion(version: string | null): boolean {
  if (!version) {
    return false
  }
  const channel = getVersionChannel(version)
  return channel !== null && hasDedicatedReleaseRepo(channel)
}

export function inferRemoteServerCheckOptions(version: string | null): UpdateCheckOptions {
  if (!version || isDedicatedRepoVersion(version)) {
    return { includePrerelease: false, includePerfPrerelease: false }
  }
  return {
    includePrerelease: isPrereleaseAppVersion(version),
    includePerfPrerelease: isPerfPrereleaseAppVersion(version)
  }
}
