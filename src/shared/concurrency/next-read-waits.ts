// Waits for a read's list, at most `capMs`: a caller that needs the list waits for that list alone,
// not for the rest of the read, so one slow step after it never holds the caller.
export class NextReadWaits {
  // Waiting on the read under way, whose list isn't applied yet; null when none is.
  private current: (() => void)[] | null = null
  // Waiting on a read that hasn't started.
  private later: (() => void)[] = []

  constructor(private readonly capMs: number) {}

  /** A read starts; call what it returns once its list is applied: it answers who waits on it. */
  reading(): () => void {
    const mine = this.later.splice(0)
    this.current = mine
    return () => {
      if (this.current === mine) {
        this.current = null
      }
      mine.splice(0).forEach((resolve) => resolve())
    }
  }

  /** Whether a read has started whose list isn't applied yet. */
  listing(): boolean {
    return this.current !== null
  }

  /** No read is running or queued: nobody waits on a list no read will bring. */
  idle(): void {
    ;[...(this.current?.splice(0) ?? []), ...this.later.splice(0)].forEach((resolve) => resolve())
    this.current = null
  }

  /** Settles once the read under way has its list (or, `later`, a read started after now), or after
   *  `capMs`. */
  next(later: boolean): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, this.capMs)
      ;(timer as { unref?: () => void }).unref?.()
      ;(later || !this.current ? this.later : this.current).push(done)
    })
  }
}
