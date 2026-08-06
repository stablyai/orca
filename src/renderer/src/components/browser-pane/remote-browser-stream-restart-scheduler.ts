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

export type RemoteBrowserStreamRestartAttempt = (attempt: {
  /** 1-based, for surfacing progress. */
  attempt: number
  isFinalAttempt: boolean
}) => Promise<boolean>

export class RemoteBrowserStreamRestartScheduler {
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  // Why: clearing the timer cannot recall an attempt already dispatched into an await. Without a
  // generation, a cancel() during that window is a no-op and the resolving attempt re-arms itself.
  private generation = 0

  constructor(
    private readonly delaysMs: readonly number[] = REMOTE_BROWSER_STREAM_RESTART_DELAYS_MS,
    private readonly onBudgetExhausted: () => void = () => {}
  ) {}

  get attemptCount(): number {
    return this.attempt
  }

  get isScheduled(): boolean {
    return this.timer !== null
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
    if (this.isBudgetExhausted) {
      this.onBudgetExhausted()
      return
    }
    const delayMs = this.delaysMs[this.attempt]!
    const attempt = this.attempt + 1
    this.attempt = attempt
    const generation = this.generation
    this.timer = setTimeout(() => {
      this.timer = null
      if (generation !== this.generation) {
        return
      }
      void run({ attempt, isFinalAttempt: attempt >= this.delaysMs.length })
        .then((shouldRetry) => {
          if (generation !== this.generation || !shouldRetry) {
            return
          }
          this.schedule(run)
        })
        .catch(() => {
          if (generation === this.generation) {
            this.schedule(run)
          }
        })
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
    // Retires any attempt already in flight so it cannot re-arm after this cancel.
    this.generation += 1
    this.attempt = 0
  }
}
