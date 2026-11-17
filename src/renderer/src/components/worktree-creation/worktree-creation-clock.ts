import { useEffect, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'

/** Ticks once a second while `running`; paused while the window is hidden to avoid unseen rerenders. */
export function useWorktreeCreationClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) {
      return
    }
    // A resumed clock reads the time at once rather than a tick later.
    setNow(Date.now())
    return installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 1000 })
  }, [running])
  return now
}

// Localized ("1m 5s", "1h 0m 5s") elapsed time; lives in a fork-owned module with the VM build clock.
export { formatElapsedTime } from './worktree-creation-clock-cloud'
