import { useEffect, useState } from 'react'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'

const USAGE_UPDATED_TICK_MS = 60_000

function hasUsableUpdatedAt(updatedAt: number | null | undefined): boolean {
  return updatedAt != null && Number.isFinite(updatedAt) && updatedAt > 0
}

/**
 * Roster `now`: reset-label boundaries plus a 60s tick for `Updated …` copy
 * while the panel is mounted. The reset scheduler is idle when every
 * `resetsAt` is null, so Updated labels would otherwise freeze.
 */
export function useUsageRosterNow(
  resetTimes: readonly (number | null | undefined)[],
  updatedAtTimes: readonly (number | null | undefined)[] = []
): number {
  const resetNow = useResetCountdownClock(resetTimes)
  const needsUpdatedTick = updatedAtTimes.some(hasUsableUpdatedAt)
  const [minuteNow, setMinuteNow] = useState(0)

  useEffect(() => {
    if (!needsUpdatedTick) {
      return
    }
    const id = window.setInterval(() => setMinuteNow(Date.now()), USAGE_UPDATED_TICK_MS)
    return () => window.clearInterval(id)
  }, [needsUpdatedTick])

  return Math.max(resetNow, needsUpdatedTick ? minuteNow : 0)
}
