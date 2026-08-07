// Why a deadline on a stream that subscribed but never said 'ready': subscribe resolves as soon as
// the request is sent, so a host that accepts and then goes silent (a hung CDP teardown does exactly
// this) leaves nothing on the client to time out. Both states that cover a pending stream are busy
// and offer no reconnect, so without this the pane sits behind a spinner with dead input handlers
// and no way back — the very strand this work exists to remove.
export const REMOTE_BROWSER_STREAM_READY_DEADLINE_MS = 30_000

// Why 'ready' alone does not prove a stream is worth trusting: it says the host accepted the
// subscribe, not that the stream is sustained. CDP allows one screencast per page, so a second
// subscriber on the same remote page evicts the first on every attempt. Treating every 'ready' as
// healthy refills the retry budget forever, which is the unbounded retry the budget exists to stop.
export const REMOTE_BROWSER_STREAM_HEALTHY_MS = 10_000

// Tracks whether one screencast subscription ever came alive, and for how long. Kept apart from the
// lifecycle because "is this stream actually alive?" is a different question from "what should the
// pane do about it?", and only the second needs tokens, status, or the retry budget.
export class RemoteBrowserStreamLiveness {
  private readyAt: number | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Starts watching a newly subscribed stream. `onNeverReady` fires once if it stays silent, and the
   * caller decides what that means — treating it as a drop keeps hung and refused hosts on one path.
   */
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

  /**
   * The stream is known not to be coming up, so stop expecting 'ready' — but keep what we already
   * know about how long it lived. Distinct from clear(): a caller that has declared the stream
   * stopped while deliberately holding its token still needs a later close to refill the budget
   * correctly, which depends on the timestamp this preserves.
   */
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
