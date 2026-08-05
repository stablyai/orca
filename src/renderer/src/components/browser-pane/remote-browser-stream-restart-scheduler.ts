// Why: caps restart cadence by attempt count, not elapsed time, and keeps retrying instead of giving up permanently.
const RESTART_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000] as const

export type RemoteBrowserStreamRestartAttempt = () => Promise<boolean>

export class RemoteBrowserStreamRestartScheduler {
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  // Why: clearing the timer cannot recall an attempt already dispatched into an await. Without a
  // generation, a cancel() during that window is a no-op and the resolving attempt re-arms itself.
  private generation = 0

  get attemptCount(): number {
    return this.attempt
  }

  get isScheduled(): boolean {
    return this.timer !== null
  }

  // Why: run() resolves true to keep retrying (transient failure), false to stop (success or superseded/missing).
  schedule(run: RemoteBrowserStreamRestartAttempt): void {
    if (this.timer !== null) {
      return
    }
    const delayMs = RESTART_DELAYS_MS[Math.min(this.attempt, RESTART_DELAYS_MS.length - 1)]
    this.attempt += 1
    const generation = this.generation
    this.timer = setTimeout(() => {
      this.timer = null
      void run().then((shouldRetry) => {
        if (shouldRetry && generation === this.generation) {
          this.schedule(run)
        }
      })
    }, delayMs)
  }

  // Why: a confirmed-live stream ('ready') forgets prior failures so the next drop backs off from scratch.
  reset(): void {
    this.attempt = 0
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // Retires any attempt already in flight so it cannot re-arm after this cancel.
    this.generation += 1
    this.attempt = 0
  }
}
