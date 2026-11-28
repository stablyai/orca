const LONG_PAUSE_MS = 2_000
const MIN_LOG_INTERVAL_MS = 10_000

/** Admits a long output-pause log line at most once per 10 s and counts the lines it held back; `always` lines (watchdog fires) are never held back. */
export class LongPauseLogLimiter {
  private lastLoggedAt = 0
  private suppressed = 0

  /** The suppressed count to log with when this pause should be logged now, else null. */
  admit(pausedMs: number, always = false): number | null {
    if (!always && pausedMs < LONG_PAUSE_MS) {
      return null
    }
    const now = Date.now()
    if (!always && now - this.lastLoggedAt < MIN_LOG_INTERVAL_MS) {
      this.suppressed += 1
      return null
    }
    const suppressed = this.suppressed
    this.lastLoggedAt = now
    this.suppressed = 0
    return suppressed
  }
}
