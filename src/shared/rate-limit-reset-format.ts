// Share renderer/mobile countdown copy without platform imports.

/** Floor durations to whole units (47m, 3h 54m, 6d 7h); nonpositive values return now for reset-specific copy. */
export function formatResetDuration(ms: number): string {
  if (ms <= 0) {
    return 'now'
  }
  const totalMins = Math.floor(ms / 60_000)
  if (totalMins < 60) {
    return `${totalMins}m`
  }
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

/** "Resets in 3h 54m" / "Resets now" for a window's time-until-reset (ms). */
export function formatResetCountdown(ms: number): string {
  const duration = formatResetDuration(ms)
  return duration === 'now' ? 'Resets now' : `Resets in ${duration}`
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Schedule just past the next floored minute/hour label boundary, not every second; choose the earliest delay across future resets. */
export function getResetCountdownNextTickDelay(
  now: number,
  resetTimes: readonly number[]
): number | null {
  let nextDelay: number | null = null
  for (const resetAt of resetTimes) {
    if (!Number.isFinite(resetAt) || resetAt <= now) {
      continue
    }
    const remainingMs = resetAt - now
    const tickUnitMs = remainingMs >= DAY_MS ? HOUR_MS : MINUTE_MS
    // Why: +1ms so the timeout fires just past the boundary the label flips on.
    const delayMs = (remainingMs % tickUnitMs) + 1
    nextDelay = nextDelay === null ? delayMs : Math.min(nextDelay, delayMs)
  }
  return nextDelay
}
