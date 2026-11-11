import { useAppStore } from '@/store'
import '../../../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { resolveBrowserPagePartition } from './browser-page-partition'

export function useBrowserPageWebviewPartition({
  sessionProfileId,
  sessionPartition
}: {
  sessionProfileId: string | null
  sessionPartition: string | null
}): string {
  // Why the local list first: this webview renders here, while Settings may be showing a paired host's profiles.
  const localProfiles = useAppStore(
    (s) => s.browserSessionProfilesByHostId[LOCAL_EXECUTION_HOST_ID]
  )
  const mirroredProfiles = useAppStore((s) => s.browserSessionProfiles)
  const activeOrcaProfileId = useAppStore((s) => s.activeOrcaProfileId)
  return resolveBrowserPagePartition({
    sessionProfileId,
    sessionPartition,
    localProfiles,
    mirroredProfiles,
    activeOrcaProfileId
  })
}
