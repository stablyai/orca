import { KeyedDeadlines } from '../../collections/keyed-deadlines'
/** Share one deadline timer while keeping each pane’s deadline/payload/cancellation independent. */
// Use elapsed monotonic time so wall-clock corrections cannot stretch poll deadlines.
const monotonicNow = (): number => performance.now()

export class CodexSubagentPollScheduler<T> {
  private readonly deadlines = new KeyedDeadlines()
  private readonly entries = new Map<string, T>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDueAt: number | undefined
  private timerGeneration = 0

  constructor(
    private readonly delayMs: number,
    private readonly onDue: (key: string, value: T) => void,
    private readonly now: () => number = monotonicNow
  ) {}

  schedule(key: string, value: T, delayMs = this.delayMs): void {
    this.entries.set(key, value)
    this.deadlines.set(key, this.now() + delayMs)
    this.arm()
  }

  clear(key: string): void {
    if (!this.entries.delete(key)) {
      return
    }
    this.deadlines.delete(key)
    this.arm()
  }

  clearAll(): void {
    this.entries.clear()
    this.deadlines.clear()
    this.cancelTimer()
  }

  get size(): number {
    return this.entries.size
  }

  private arm(): void {
    if (this.entries.size === 0) {
      this.cancelTimer()
      return
    }

    const nextDueAt = this.deadlines.next
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
        // Queued callbacks from replaced timers must not consume the active timer’s metadata or entries.
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
      // Select one entry per callback so it can cancel unfired siblings like independent timers.
      while (this.deadlines.next <= now) {
        const key = this.deadlines.firstKey!
        const value = this.entries.get(key)!
        this.deadlines.delete(key)
        this.entries.delete(key)
        this.onDue(key, value)
      }
    } finally {
      this.arm()
    }
  }
}
