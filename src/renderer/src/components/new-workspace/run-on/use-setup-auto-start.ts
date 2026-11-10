// O4: setup started from this composer (or its restored draft) starts the workspace by itself.
// When every required row is done, hold "All set", then submit as if ⌘↵ had been pressed.
import { useEffect, useState } from 'react'
import { CLOUD_SETUP_ALL_SET_HOLD_MS } from '@/lib/orca-cloud/cloud-setup-session-seam'
import { recordCloudSetupFirstSandbox } from '@/lib/orca-cloud/cloud-setup-telemetry'
import { prefersReducedMotion } from './cloud-start-view'

/** Returns whether "All set" is showing. `onStart` ends the trip state, then creates. */
export function useSetupAutoStart({
  armed,
  done,
  setupSessionId,
  onStart
}: {
  /** Setup was started here and Orca Cloud is still the target. */
  armed: boolean
  /** Every required row is done, or the session says it finished. */
  done: boolean
  setupSessionId: string | null
  onStart: () => void
}): boolean {
  const [allSet, setAllSet] = useState(false)
  useEffect(() => {
    if (!armed || !done) {
      return
    }
    setAllSet(true)
    const timer = window.setTimeout(
      () => {
        setAllSet(false)
        // N10: time to first sandbox, from when the tracker first saw this trip.
        if (setupSessionId) {
          recordCloudSetupFirstSandbox({ sessionId: setupSessionId, hoursSource: 'unknown' })
        }
        onStart()
      },
      prefersReducedMotion() ? 0 : CLOUD_SETUP_ALL_SET_HOLD_MS
    )
    return () => window.clearTimeout(timer)
  }, [armed, done, onStart, setupSessionId])
  return allSet
}
