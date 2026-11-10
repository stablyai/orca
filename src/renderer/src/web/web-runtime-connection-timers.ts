type TimerName = 'connect' | 'handshake' | 'reconnect'

/** The web transport's one-shot timers; arming a timer replaces any pending one of that name. */
export class WebRuntimeConnectionTimers {
  private readonly timers = new Map<TimerName, number>()

  arm(name: TimerName, delayMs: number, fire: () => void): void {
    this.clear(name)
    this.timers.set(
      name,
      window.setTimeout(() => {
        this.timers.delete(name)
        fire()
      }, delayMs)
    )
  }

  has(name: TimerName): boolean {
    return this.timers.has(name)
  }

  clear(name: TimerName): void {
    const timer = this.timers.get(name)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      this.timers.delete(name)
    }
  }

  clearAll(): void {
    for (const name of Array.from(this.timers.keys())) {
      this.clear(name)
    }
  }
}
