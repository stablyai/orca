import { useAppStore } from '@/store'
import { ORCA_BROWSER_PARTITION } from '../../../../../shared/constants'
import { getOrcaProfileBrowserDefaultPartition } from '../../../../../shared/orca-profiles'

export function useBrowserPageWebviewPartition({
  sessionProfileId,
  sessionPartition
}: {
  sessionProfileId: string | null
  sessionPartition: string | null
}): string {
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const activeOrcaProfileId = useAppStore((s) => s.activeOrcaProfileId)
  const fallbackBrowserPartition = activeOrcaProfileId
    ? getOrcaProfileBrowserDefaultPartition(activeOrcaProfileId)
    : null
  const defaultSessionProfile = browserSessionProfiles.find((p) => p.id === 'default') ?? null
  const sessionProfile = sessionProfileId
    ? (browserSessionProfiles.find((p) => p.id === sessionProfileId) ?? null)
    : defaultSessionProfile
  return (
    sessionPartition ??
    sessionProfile?.partition ??
    defaultSessionProfile?.partition ??
    fallbackBrowserPartition ??
    ORCA_BROWSER_PARTITION
  )
}
