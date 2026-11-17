import { BuildLogBuffer } from './build-log-model'

const silentScheduler = (): void => {}

/**
 * Routes stream events into the visible buffer. A replay from byte 0 (a reconnect, or a `reset`
 * event) goes into a hidden shadow buffer that is swapped in once it has caught up, so the reader
 * never sees the log empty out and refill, and their scroll position survives.
 */
export class LogReplayRouter {
  private shadow: BuildLogBuffer | null = null
  /** Most lines the visible log has ever had; growth past it is real progress. */
  private highWater = 0

  constructor(private readonly target: BuildLogBuffer) {
    this.highWater = target.lines.length
  }

  get replaying(): boolean {
    return this.shadow !== null
  }

  /** The stream will resend the log from its first byte. */
  beginReplay(): void {
    this.shadow = this.target.lines.length > 0 ? new BuildLogBuffer(silentScheduler) : null
    if (!this.shadow) {
      this.target.reset()
    }
  }

  /** A `reset` event: identical to a replay starting. */
  reset(): void {
    this.beginReplay()
  }

  /** Appends a chunk; returns true when the visible log grew past anything it showed before. */
  append(stream: 'stdout' | 'stderr', data: string, at?: number): boolean {
    if (this.shadow) {
      this.shadow.append(stream, data, at)
      if (this.shadow.lines.length >= this.target.lines.length) {
        this.swap()
      }
    } else {
      this.target.append(stream, data, at)
    }
    return this.noteGrowth()
  }

  /** The stream ended; a replay that never caught up (the log shrank) still wins. */
  close(): void {
    if (this.shadow) {
      this.shadow.close()
      this.swap()
    }
    this.target.close()
  }

  /** Give up on a replay that never completed: keep what the reader already has. */
  abandon(): void {
    this.shadow = null
    this.target.close()
  }

  private swap(): void {
    if (this.shadow) {
      this.target.adopt(this.shadow)
      this.shadow = null
    }
  }

  private noteGrowth(): boolean {
    if (this.shadow || this.target.lines.length <= this.highWater) {
      return false
    }
    this.highWater = this.target.lines.length
    return true
  }
}
