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
