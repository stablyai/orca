import { useLayoutEffect, useState } from 'react'

// A small shared pattern for UI labels that need a current wall-clock value.
// Callers should keep the interval at the coarsest useful granularity.
export function useNow(intervalMs = 30_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())

  useLayoutEffect(() => {
    if (!enabled) {
      return
    }
    // Refresh on activation so a remounted or re-enabled surface never waits
    // for the first interval tick to catch up with wall time.
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [enabled, intervalMs])

  return now
}
