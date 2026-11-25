// One run at a time: one asked for while a run is out runs once after it, and every caller's promise
// settles after that last run, so no older answer lands last.
export class SerialRerun {
  private running: Promise<void> | null = null
  private again = false

  constructor(private readonly run: () => Promise<void>) {}

  /** The run under way, with any asked for meanwhile; null when none is. */
  current(): Promise<void> | null {
    return this.running
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
          await this.run()
        } while (this.again)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }
}
