import type { RateLimitWindow } from './rate-limit-types'
import { clampUsedPercent } from './usage-percentage-display'

export type RateLimitWindowPace = {
  /** Percent of the window duration already elapsed (0–100, unrounded). */
  elapsedPercent: number
  /** True when consumption runs ahead of elapsed time in the window. */
  overPace: boolean
}

// Monthly windows are calendar billing periods (28–31 days), so a fixed
// nominal duration would fabricate the start; pace only applies to rolling
// windows up to 7 days whose duration is authoritative.
const MAX_ROLLING_WINDOW_MINUTES = 10080

// Windows only report their end (`resetsAt`); the start is derived from the
// fixed duration. Pace is undefined when the reset is unknown, already passed
// (stale snapshot), or further away than one window length — derived
// Codex/MiniMax window lengths can make the two fields inconsistent.
export function getRateLimitWindowPace(
  w: RateLimitWindow,
  now: number
): RateLimitWindowPace | null {
  if (typeof w.resetsAt !== 'number' || !Number.isFinite(w.resetsAt)) {
    return null
  }
  if (
    !Number.isFinite(w.windowMinutes) ||
    w.windowMinutes <= 0 ||
    w.windowMinutes > MAX_ROLLING_WINDOW_MINUTES
  ) {
    return null
  }
  const durationMs = w.windowMinutes * 60_000
  const remainingMs = w.resetsAt - now
  if (remainingMs <= 0 || remainingMs > durationMs) {
    return null
  }
  const elapsedPercent = ((durationMs - remainingMs) / durationMs) * 100
  return { elapsedPercent, overPace: clampUsedPercent(w.usedPercent) > elapsedPercent }
}
