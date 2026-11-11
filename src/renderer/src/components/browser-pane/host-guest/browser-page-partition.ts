import type { BrowserSessionProfile } from '../../../../../shared/browser-workspace-types'
import { ORCA_BROWSER_PARTITION } from '../../../../../shared/browser/browser-session-partition'
import { getOrcaProfileBrowserDefaultPartition } from '../../../../../shared/orca-profiles'
import { unadmittedBrowserPartition } from '../../../../../shared/browser/profiles/browser-profile-scope'

export function resolveBrowserPagePartition({
  sessionProfileId,
  sessionPartition,
  localProfiles,
  mirroredProfiles,
  activeOrcaProfileId
}: {
  sessionProfileId: string | null
  sessionPartition: string | null
  localProfiles: readonly BrowserSessionProfile[] | undefined
  mirroredProfiles: readonly BrowserSessionProfile[]
  activeOrcaProfileId: string | null
}): string {
  const browserSessionProfiles = localProfiles ?? mirroredProfiles
  const fallbackBrowserPartition = activeOrcaProfileId
    ? getOrcaProfileBrowserDefaultPartition(activeOrcaProfileId)
    : null
  const defaultSessionProfile = browserSessionProfiles.find((p) => p.id === 'default') ?? null
  const sessionProfile = sessionProfileId
    ? (browserSessionProfiles.find((p) => p.id === sessionProfileId) ?? null)
    : defaultSessionProfile
  if (sessionPartition) {
    return sessionPartition
  }
  // A deleted profile must not fall back to Default's cookie jar.
  if (sessionProfileId && !sessionProfile && localProfiles) {
    return unadmittedBrowserPartition(sessionProfileId)
  }
  return (
    sessionProfile?.partition ??
    defaultSessionProfile?.partition ??
    fallbackBrowserPartition ??
    ORCA_BROWSER_PARTITION
  )
}
