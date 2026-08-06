import { useEffect, useMemo, useRef, useState } from 'react'
import { getResetCountdownNextTickDelay } from '../../../shared/rate-limit-reset-format'

// Why: a single boundary-scheduled clock drives the status-bar reset countdowns
// so the collapsed badge ticks live (matching the popover) without a per-second
// interval. It wakes once, just after the next label boundary, and reschedules.

function resetTimesKey(resetTimes: readonly (number | null | undefined)[]): string {
  return resetTimes
    .filter((resetAt): resetAt is number => resetAt != null && Number.isFinite(resetAt))
    .sort((a, b) => a - b)
    .join('|')
}

function parseResetTimesKey(key: string): number[] {
  return key.length === 0 ? [] : key.split('|').map((value) => Number(value))
}

/**
 * Returns a `now` timestamp that advances whenever the soonest reset countdown
 * label is due to change. Pass the window `resetsAt` values; feed the returned
 * `now` into the label formatter so it stays live.
 */
export function useResetCountdownClock(resetTimes: readonly (number | null | undefined)[]): number {
  const [scheduledNow, setScheduledNow] = useState(() => Date.now())
  const key = useMemo(() => resetTimesKey(resetTimes), [resetTimes])
  const times = useMemo(() => parseResetTimesKey(key), [key])
  const previousKeyRef = useRef(key)
  const immediateNowRef = useRef(scheduledNow)

  // Why: when the set of reset times changes, refresh `now` immediately so the
  // label reflects the new window without waiting for the next scheduled tick.
  if (previousKeyRef.current !== key) {
    previousKeyRef.current = key
    immediateNowRef.current = Date.now()
  }

  const now = Math.max(scheduledNow, immediateNowRef.current)

  useEffect(() => {
    const delayMs = getResetCountdownNextTickDelay(now, times)
    if (delayMs === null) {
      return
    }
    const timeout = window.setTimeout(() => setScheduledNow(Date.now()), delayMs)
    return () => window.clearTimeout(timeout)
  }, [now, times])

  return now
}
