import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'

/**
 * How long a restored client-hosted page waits for its host to hand it back before the pane stops
 * showing it as loading.
 *
 * There is no negative outcome to wait for. A page the runtime cannot recover — its record released
 * as unrecoverable, or the tab closed from another client while this desktop was down — simply never
 * appears in a snapshot, and the restored marker exempts the row from the absent-from-snapshot cull,
 * so nothing else ever resolves it. This window is the only bound.
 *
 * Longer than the runtime's own per-page creation ceiling (DEFAULT_CLIENT_PAGE_CREATION_TIMEOUT_MS),
 * which bounds the FIRST BATCH of recoveries and nothing beyond it: recovery runs four pages at a
 * time and each awaits a create and then a navigate, so the Nth restored page is not owed an answer
 * until roughly ceil(N/4) x (create + navigate). Past the first batch this notice can appear on a
 * page that is still recovering normally. That is knowingly early rather than wrong — the window is
 * revocable, and a placement that lands later clears the notice on its own.
 */
export const RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS = 45_000

/**
 * Whether a restored client-hosted page has waited long enough that the pane should offer the
 * unavailable notice instead of a spinner. The row itself stays — reopening on the server is the
 * user's decision, not this window's.
 */
export function useRestoredClientHostedRecoveryWindow({
  browserPageId,
  environmentId,
  placementPending
}: {
  browserPageId: string
  environmentId: string
  placementPending: boolean
}): boolean {
  // Cleared by the first snapshot that publishes the page, which is also what supplies the
  // placement — so this reads false the moment recovery succeeds.
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
    // Why the clock starts at reachable rather than at mount: an unreachable environment has not
    // been asked yet, and its own disconnected state already explains the wait.
    if (!environmentReachable) {
      return
    }
    const timer = setTimeout(
      () => setWindowElapsed(true),
      RESTORED_CLIENT_HOSTED_RECOVERY_WINDOW_MS
    )
    return () => clearTimeout(timer)
  }, [awaitingRecovery, environmentReachable])

  // The effect's reset clears this too, one render later — the conjunct is what keeps the notice
  // off the frame between the placement landing and that reset running.
  return awaitingRecovery && windowElapsed
}
