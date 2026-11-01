// Bound automatic attempts before handing control to Reconnect; elapsed time also includes each stream’s ready deadline.
export const REMOTE_BROWSER_STREAM_RESTART_DELAYS_MS: readonly number[] = [
  500, 1_000, 2_000, 4_000, 8_000
]

export type RemoteBrowserStreamRestartAttempt = () => Promise<boolean>

export class RemoteBrowserStreamRestartScheduler {
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private inFlightGeneration: number | null = null
  private queuedRun: RemoteBrowserStreamRestartAttempt | null = null

  constructor(
    private readonly delaysMs: readonly number[] = REMOTE_BROWSER_STREAM_RESTART_DELAYS_MS,
    private readonly onBudgetExhausted: () => void = () => {}
  ) {}

  get attemptCount(): number {
    return this.attempt
  }

  get isScheduled(): boolean {
    return (
      this.timer !== null || this.inFlightGeneration === this.generation || this.queuedRun !== null
    )
  }

  get isBudgetExhausted(): boolean {
    return this.attempt >= this.delaysMs.length
  }

  // True requests another attempt; false stops for success or supersession. Exhaustion stops either outcome.
  schedule(run: RemoteBrowserStreamRestartAttempt): void {
    if (this.timer !== null) {
      return
    }
    if (this.inFlightGeneration === this.generation) {
      this.queuedRun = run
      return
    }
    if (this.isBudgetExhausted) {
      this.onBudgetExhausted()
      return
    }
    const delayMs = this.delaysMs[this.attempt]!
    this.attempt += 1
    const generation = this.generation
    this.timer = setTimeout(() => {
      this.timer = null
      if (generation !== this.generation) {
        return
      }
      this.inFlightGeneration = generation
      void Promise.resolve()
        .then(run)
        .then(
          (shouldRetry) => this.finishAttempt(generation, run, shouldRetry),
          () => this.finishAttempt(generation, run, true)
        )
    }, delayMs)
  }

  // The lifecycle resets after sustained uptime, not ready alone; the next drop then receives a full budget.
  reset(): void {
    this.attempt = 0
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.queuedRun = null
    this.generation += 1
    this.attempt = 0
  }

  private finishAttempt(
    generation: number,
    run: RemoteBrowserStreamRestartAttempt,
    shouldRetry: boolean
  ): void {
    if (generation !== this.generation) {
      return
    }
    this.inFlightGeneration = null
    const nextRun = this.queuedRun ?? (shouldRetry ? run : null)
    this.queuedRun = null
    if (nextRun) {
      this.schedule(nextRun)
    }
  }
}
