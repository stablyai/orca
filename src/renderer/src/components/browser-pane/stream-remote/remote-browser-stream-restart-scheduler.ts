// Why a retry budget rather than "retry until it works" or "give up after one try": both extremes
// fail the user. One attempt strands the pane on any blip with no way back. Unbounded retry hides a
// genuinely dead stream behind background work that never stops and an error that keeps reappearing.
//
// The budget covers the transient case invisibly, then hands control back: once it is spent the pane
// reports that it stopped and offers an explicit reconnect. That also removes the sharpest edge in
// this area — misjudging a failure as permanent is no longer unrecoverable, because the user always
// has a way to ask again.
//
// Counts attempts, not elapsed time. A host that refuses fast spends the budget in ~16s; one that
// accepts and then hangs spends it far more slowly, since each attempt carries its own timeout.
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

  // Kept for tests: reset()/cancel() restoring the budget is behaviour worth asserting directly,
  // and the counter is the only honest way to observe it.
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

  // Why: run() resolves true to keep retrying (transient failure), false to stop (success or
  // superseded/missing). Retries stop regardless once the budget is spent.
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

  // Why: a confirmed-live stream ('ready') forgets prior failures so the next drop backs off from
  // scratch — and gets the whole budget again rather than the tail of an earlier one.
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
