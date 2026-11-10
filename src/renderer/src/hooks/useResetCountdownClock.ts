import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getResetCountdownNextTickDelay } from '../../../shared/rate-limit-reset-format'

// Schedule one wake just after the next label boundary, then reschedule; badge/popover stay live without per-second ticks.

function resetTimesKey(resetTimes: readonly (number | null | undefined)[]): string {
  return resetTimes
    .filter((resetAt): resetAt is number => resetAt != null && Number.isFinite(resetAt))
    .sort((a, b) => a - b)
    .join('|')
}

function parseResetTimesKey(key: string): number[] {
  return key.length === 0 ? [] : key.split('|').map((value) => Number(value))
}

/** Advance now at the soonest resetsAt label boundary; pass it into the countdown formatter. */
export function useResetCountdownClock(resetTimes: readonly (number | null | undefined)[]): number {
  const [scheduledNow, setScheduledNow] = useState(() => Date.now())
  const key = useMemo(() => resetTimesKey(resetTimes), [resetTimes])
  const times = useMemo(() => parseResetTimesKey(key), [key])
  const previousKeyRef = useRef(key)
  // Refresh before paint when reset windows change to avoid stale intermediate labels.
  useLayoutEffect(() => {
    if (previousKeyRef.current === key) {
      return
    }
    previousKeyRef.current = key
    setScheduledNow(Date.now())
  }, [key])

  useEffect(() => {
    const delayMs = getResetCountdownNextTickDelay(scheduledNow, times)
    if (delayMs === null) {
      return
    }
    const timeout = window.setTimeout(() => setScheduledNow(Date.now()), delayMs)
    return () => window.clearTimeout(timeout)
  }, [scheduledNow, times])

  return scheduledNow
}
