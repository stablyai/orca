// Why: shared by the desktop status-bar tooltip and the mobile accounts screen
// so rate-limit reset/expiry countdown copy stays identical across surfaces.
// Pure (no platform imports) — safe to bundle in both the renderer and mobile.

/**
 * Compact human duration for a rate-limit window, flooring to whole units:
 * "47m", "3h 54m", "6d 7h". Returns "now" for a non-positive delta so callers
 * can special-case the "already reset" copy.
 */
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

/**
 * Delay (ms) until the soonest reset countdown label would change, or null when
 * no future reset needs a tick. Because labels are floored to minutes (or hours
 * past a day), a countdown clock only needs to wake just after the next unit
 * boundary — not every second — so callers schedule one short-lived timeout
 * instead of polling. Returns the minimum delay across all reset times.
 */
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
