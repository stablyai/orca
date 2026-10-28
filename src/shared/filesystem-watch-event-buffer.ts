import type { FsChangeEvent } from './filesystem-entry-types'

export const MAX_BUFFERED_FILE_WATCH_EVENTS = 5_000

export class FileWatchEventBuffer {
  private events: FsChangeEvent[] = []
  private overflowed = false

  get size(): number {
    return this.events.length
  }

  push(nextEvents: readonly FsChangeEvent[]): void {
    if (nextEvents.length === 0 || this.overflowed) {
      return
    }
    const incomingOverflow = nextEvents.find((event) => event.kind === 'overflow')
    if (incomingOverflow) {
      this.events = [incomingOverflow]
      this.overflowed = true
    } else if (this.events.length + nextEvents.length > MAX_BUFFERED_FILE_WATCH_EVENTS) {
      this.events = [{ kind: 'overflow', absolutePath: nextEvents[0].absolutePath }]
      this.overflowed = true
    } else {
      for (const event of nextEvents) {
        this.events.push(event)
      }
    }
  }

  take(): FsChangeEvent[] {
    const events = this.events
    this.clear()
    return events
  }

  clear(): void {
    this.events = []
    this.overflowed = false
  }
}
