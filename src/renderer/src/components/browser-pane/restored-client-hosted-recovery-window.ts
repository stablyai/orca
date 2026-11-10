import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'

/** Bound absent restored pages beyond the first create ceiling; later four-page recovery batches may outlast it, so placement must revoke the notice. */
export const RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS = 45_000

/** Offer an unavailable notice after the window; keep the row until the user chooses to close or reopen it. */
export function useRestoredClientHostedRecoveryWindow({
  browserPageId,
  environmentId,
  placementPending
}: {
  browserPageId: string
  environmentId: string
  placementPending: boolean
}): boolean {
  // The snapshot supplying placement also clears the restored marker.
  const restoredFromSession = useAppStore(
    (s) => s.remoteBrowserPageHandlesByPageId[browserPageId]?.restoredFromSession === true
  )
  const environmentReachable = useAppStore(
    (s) => s.runtimeStatusByEnvironmentId.get(environmentId)?.status != null
  )
  const awaitingRecovery = restoredFromSession && placementPending
  const [windowElapsed, setWindowElapsed] = useState(false)

  useEffect(() => {
    if (!awaitingRecovery) {
      setWindowElapsed(false)
      return
    }
    // An unreachable host has not been asked to recover yet; start the clock only when reachable.
    if (!environmentReachable) {
      return
    }
    const timer = setTimeout(
      () => setWindowElapsed(true),
      RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS
    )
    return () => clearTimeout(timer)
  }, [awaitingRecovery, environmentReachable])

  // Hide the notice as soon as placement lands, before the effect resets the elapsed flag.
  return awaitingRecovery && windowElapsed
}
