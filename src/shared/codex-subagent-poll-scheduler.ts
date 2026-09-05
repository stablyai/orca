/**
 * Coalesces per-pane Codex transcript wakeups onto one deadline timer.
 *
 * Each key still owns its own deadline and payload; only the timer that wakes
 * the process is shared. This keeps pane cancellation and ordering independent
 * while avoiding one live timer per pane.
 */
// Timer APIs and performance.now() both use elapsed monotonic time; wall-clock
// corrections must not stretch a pending poll's deadline.
const monotonicNow = (): number => performance.now()

export class CodexSubagentPollScheduler<T> {
  private readonly entries = new Map<string, { value: T; dueAt: number }>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDueAt: number | undefined
  private timerGeneration = 0

  constructor(
    private readonly delayMs: number,
    private readonly onDue: (key: string, value: T) => void,
    private readonly now: () => number = monotonicNow
  ) {}

  schedule(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, { value, dueAt: this.now() + this.delayMs })
    this.arm()
  }

  clear(key: string): void {
    if (!this.entries.delete(key)) {
      return
    }
    this.arm()
  }

  clearAll(): void {
    this.entries.clear()
    this.cancelTimer()
  }

  /** Number of pane wakeups currently waiting for a deadline. */
  get size(): number {
    return this.entries.size
  }

  private arm(): void {
    if (this.entries.size === 0) {
      this.cancelTimer()
      return
    }

    let nextDueAt = Number.POSITIVE_INFINITY
    for (const entry of this.entries.values()) {
      nextDueAt = Math.min(nextDueAt, entry.dueAt)
    }
    if (this.timer !== undefined && this.timerDueAt === nextDueAt) {
      return
    }
    if (this.timer !== undefined) {
      this.cancelTimer()
    }
    const generation = ++this.timerGeneration
    this.timerDueAt = nextDueAt
    const timer = setTimeout(
      () => {
        // A cleared/replaced timer can still have its callback queued. It must
        // not consume the active timer's metadata or flush its entries.
        if (this.timerGeneration !== generation || this.timer !== timer) {
          return
        }
        this.timer = undefined
        this.timerDueAt = undefined
        this.flush()
      },
      Math.max(0, nextDueAt - this.now())
    )
    this.timer = timer
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private cancelTimer(): void {
    const timer = this.timer
    this.timer = undefined
    this.timerDueAt = undefined
    this.timerGeneration += 1
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }

  private flush(): void {
    const now = this.now()
    try {
      // Find one entry at a time so a callback can clear a sibling that has
      // not fired yet, matching independent timer cancellation semantics.
      while (true) {
        let dueEntry: { key: string; value: T } | undefined
        for (const [key, entry] of this.entries) {
          if (entry.dueAt <= now) {
            dueEntry = { key, value: entry.value }
            break
          }
        }
        if (!dueEntry) {
          break
        }
        this.entries.delete(dueEntry.key)
        this.onDue(dueEntry.key, dueEntry.value)
      }
    } finally {
      // A callback may have scheduled, cleared, or replaced any key.
      this.arm()
    }
  }
}
