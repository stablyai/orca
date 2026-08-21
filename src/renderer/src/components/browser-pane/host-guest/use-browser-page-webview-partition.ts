import { useAppStore } from '@/store'
import { MCODE_BROWSER_PARTITION } from '../../../../../shared/constants'
import { getMCodeProfileBrowserDefaultPartition } from '../../../../../shared/mcode-profiles'

export function useBrowserPageWebviewPartition({
  sessionProfileId,
  sessionPartition
}: {
  sessionProfileId: string | null
  sessionPartition: string | null
}): string {
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const activeMCodeProfileId = useAppStore((s) => s.activeMCodeProfileId)
  const fallbackBrowserPartition = activeMCodeProfileId
    ? getMCodeProfileBrowserDefaultPartition(activeMCodeProfileId)
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
    MCODE_BROWSER_PARTITION
  )
}
