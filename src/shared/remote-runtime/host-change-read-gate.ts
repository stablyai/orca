/**
 * When to read a host's state again after it announces a change. Any reader of a host's change events
 * must go through this gate, one gate per source it reads: a busy agent announces every step, and
 * events, backstop polls, reconnects and readers all asking at once still cost one read per floor.
 */

/** The least time between two reads of one source; also how often a visible host list polls. */
export const HOST_READ_FLOOR_MS = 3_000

export type HostReadGateClock = {
  now: () => number
  /** Runs `run` after `ms`; the returned function cancels it. */
  after: (ms: number, run: () => void) => () => void
}

const systemClock: HostReadGateClock = {
  now: () => Date.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  }
}

export type HostReadGateSource = {
  floorMs: number
  /** Starts one read; the caller reports when it settles (readSettled), failed or not. */
  read: () => void
  /** Someone shows this source's answer now; otherwise a change only marks it stale. */
  watching: () => boolean
  /** A read could reach the host now; otherwise a change waits for the stream to go live again. */
  connected: () => boolean
  /** The held answer is out of date: on each change, and when a read that predates one settles. */
  onStale?: () => void
  clock?: HostReadGateClock
}

/** Reads the caller already has out or answered when the gate starts (0: never). */
export type HostReadGateSeed = { inFlight: boolean; startedAt: number; settledAt: number }

export class HostReadGate {
  private readonly clock: HostReadGateClock
  // A change no read started since then covers.
  private stale = false
  // A read the caller asked for itself (its own write's result): no floor, still one at a time.
  private requested = false
  // Someone reads the held answer, so a stale one is read even with nobody watching.
  private consumed = false
  private inFlight: boolean
  private startedAt: number
  private settledAt: number
  private cancelTimer: (() => void) | null = null

  constructor(
    private readonly source: HostReadGateSource,
    seed: HostReadGateSeed = { inFlight: false, startedAt: 0, settledAt: 0 }
  ) {
    this.clock = source.clock ?? systemClock
    ;({ inFlight: this.inFlight, startedAt: this.startedAt, settledAt: this.settledAt } = seed)
  }

  /** The host announced a change, or a backstop poll came due. */
  changed(): void {
    this.stale = true
    this.source.onStale?.()
    this.schedule()
  }

  /** Reads now, or right after the read in flight, which may predate what the caller just did. */
  request(): void {
    this.requested = true
    this.changed()
  }

  /** Someone reads the held answer now, watching or not: read it if it went stale. */
  watched(): void {
    if (this.stale) {
      this.consumed = true
      this.schedule()
    }
  }

  /** A reader asks for the current answer itself, watching or not: read at the floor. */
  polled(): void {
    this.consumed = true
    this.changed()
  }

  /** Nothing went stale since the last read started. */
  get current(): boolean {
    return !this.stale
  }

  get reading(): boolean {
    return this.inFlight
  }

  /** The change stream is live again and events before `since` may be missed: reads not started after it are stale. */
  live(since: number = this.clock.now()): void {
    if (this.startedAt <= since) {
      this.changed()
    }
  }

  /** A read started, by this gate or by the caller (a poll, a screen mounting). */
  readStarted(): void {
    if (!this.inFlight) {
      this.inFlight = true
      this.startedAt = this.clock.now()
      this.stale = false
      this.requested = false
      this.consumed = false
    }
  }

  readSettled(): void {
    if (!this.inFlight) {
      return
    }
    this.inFlight = false
    this.settledAt = this.clock.now()
    if (this.stale) {
      // Its answer predates a change that came while it was out.
      this.source.onStale?.()
      this.schedule()
    }
  }

  dispose(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private schedule(): void {
    if (!this.stale || this.inFlight || !this.source.connected()) {
      return
    }
    if (!this.consumed && !this.source.watching()) {
      return
    }
    const wait = this.requested ? 0 : this.settledAt + this.source.floorMs - this.clock.now()
    if (wait <= 0) {
      this.dispose()
      this.readStarted()
      this.source.read()
      return
    }
    this.cancelTimer ??= this.clock.after(wait, () => {
      this.cancelTimer = null
      this.schedule()
    })
  }
}
