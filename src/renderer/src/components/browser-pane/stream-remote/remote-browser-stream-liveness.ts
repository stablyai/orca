// Subscribe resolves when sent; bound hosts that never say ready so busy panes eventually offer recovery.
export const REMOTE_BROWSER_STREAM_READY_DEADLINE_MS = 30_000

// CDP subscribers can evict each other immediately after ready; require sustained uptime before refilling the retry budget.
export const REMOTE_BROWSER_STREAM_HEALTHY_MS = 10_000

export class RemoteBrowserStreamLiveness {
  private readyAt: number | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null

  /** Watch once for a silent subscription; the caller handles expiry as a drop. */
  watch(onNeverReady: () => void): void {
    this.clear()
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null
      onNeverReady()
    }, REMOTE_BROWSER_STREAM_READY_DEADLINE_MS)
  }

  markReady(): void {
    this.clearDeadline()
    this.readyAt = Date.now()
  }

  /** Cancel the ready deadline while retaining uptime so a later close can refill a healthy stream’s budget. */
  stopWaitingForReady(): void {
    this.clearDeadline()
  }

  /** Ends the current watch and reports whether the stream stayed up long enough to be trusted. */
  settle(): boolean {
    this.clearDeadline()
    const readyAt = this.readyAt
    this.readyAt = null
    return readyAt !== null && Date.now() - readyAt >= REMOTE_BROWSER_STREAM_HEALTHY_MS
  }

  clear(): void {
    this.clearDeadline()
    this.readyAt = null
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer)
      this.deadlineTimer = null
    }
  }
}
