const IDLE_CLOSE_MS = 60_000

/** Closes an unused request connection after a quiet minute; never keeps the process alive. */
export class RemoteRuntimeRequestIdleClose {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly close: () => void) {}

  schedule(): void {
    this.clear()
    this.timer = setTimeout(this.close, IDLE_CLOSE_MS)
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
