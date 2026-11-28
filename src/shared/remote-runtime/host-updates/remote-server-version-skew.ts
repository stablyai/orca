import { compareAppVersions, isValidAppVersion } from '../../app-lifecycle/identity/app-version'

/** This app's version when the server runs a newer one; updating the server can't close that gap. */
export function getRemoteServerNewerThanClientVersion(entry: {
  currentVersion: string | null
  clientVersion?: string | null
}): string | null {
  const { currentVersion, clientVersion } = entry
  return currentVersion &&
    clientVersion &&
    isValidAppVersion(currentVersion) &&
    isValidAppVersion(clientVersion) &&
    compareAppVersions(currentVersion, clientVersion) > 0
    ? clientVersion
    : null
}
