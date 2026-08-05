// Why: caps restart cadence by attempt count, not elapsed time, and keeps retrying instead of giving up permanently.
const RESTART_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000] as const

export type RemoteBrowserStreamRestartAttempt = () => Promise<boolean>

export class RemoteBrowserStreamRestartScheduler {
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null

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
    this.timer = setTimeout(() => {
      this.timer = null
      void run().then((shouldRetry) => {
        if (shouldRetry) {
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
    this.attempt = 0
  }
}
