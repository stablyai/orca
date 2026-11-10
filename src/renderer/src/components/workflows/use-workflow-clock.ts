import { useEffect, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'

/** Wall time refreshed on an interval, read in effects so render stays pure; 0 before the first tick. */
export function useWorkflowClock(intervalMs = 1_000): number {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const tick = (): void => setNow(Date.now())
    // Runs once now. Elapsed-time labels only matter while the window is visible.
    return installWindowVisibilityInterval({ run: tick, intervalMs })
  }, [intervalMs])
  return now
}
