// Compact elapsed-time labels for notch rows. Width matters more than precision here: the
// column is a few characters wide and repaints every second, so the format never grows.

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * `12s`, `5m`, `1h 04m`, `3d`. Sub-second and negative deltas read as `0s` — a clock skew
 * between a hook's timestamp and the local clock must not render `-4s`.
 */
export function formatNotchDuration(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < SECOND_MS) {
    return '0s'
  }
  if (elapsedMs < MINUTE_MS) {
    return `${Math.floor(elapsedMs / SECOND_MS)}s`
  }
  if (elapsedMs < HOUR_MS) {
    return `${Math.floor(elapsedMs / MINUTE_MS)}m`
  }
  if (elapsedMs < DAY_MS) {
    const hours = Math.floor(elapsedMs / HOUR_MS)
    const minutes = Math.floor((elapsedMs % HOUR_MS) / MINUTE_MS)
    return `${hours}h ${String(minutes).padStart(2, '0')}m`
  }
  return `${Math.floor(elapsedMs / DAY_MS)}d`
}

export function formatNotchElapsedSince(startedAt: number, now: number): string {
  return formatNotchDuration(now - startedAt)
}
