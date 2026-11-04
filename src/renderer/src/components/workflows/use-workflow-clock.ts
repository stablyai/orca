import { useEffect, useState } from 'react'

/** Wall time refreshed on an interval, read in effects so render stays pure; 0 before the first tick. */
export function useWorkflowClock(intervalMs = 1_000): number {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const tick = (): void => setNow(Date.now())
    tick()
    const timer = setInterval(tick, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
