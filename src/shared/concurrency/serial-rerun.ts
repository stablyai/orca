import { NextReadWaits } from './next-read-waits'

// One run at a time: one asked for while a run is out runs once after it, and every caller's promise
// settles after that last run, so no older answer lands last. A run calls `listed` once the part a
// caller may wait for (`nextListed`) is done, so the caller never waits for the rest of it.
export class SerialRerun {
  private running: Promise<void> | null = null
  private again = false
  private readonly waits: NextReadWaits

  constructor(
    private readonly run: (listed: () => void) => Promise<void>,
    waitCapMs = 5000
  ) {
    this.waits = new NextReadWaits(waitCapMs)
  }

  /** The run under way, with any asked for meanwhile; null when none is. */
  current(): Promise<void> | null {
    return this.running
  }

  /** Once a run under way or asked for has called `listed`, at most the cap; at once when none is. */
  async nextListed(): Promise<void> {
    if (this.waits.listing() || this.again) {
      await this.waits.next(this.again)
    }
  }

  start(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      // Cleared in the same turn as the last check, so a run asked for after it starts anew.
      try {
        do {
          this.again = false
          const listed = this.waits.reading()
          try {
            await this.run(listed)
          } finally {
            listed()
          }
        } while (this.again)
      } finally {
        this.running = null
        this.waits.idle()
      }
    })()
    return this.running
  }
}
