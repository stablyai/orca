import type { RuntimeRpcResponse } from '../../runtime-rpc-envelope'

// Why: ws pings prove only the nearest hop and the host's socket layer. A relay, proxy or a runtime whose
// request path is stuck still answers them, so a socket can stay "ready" for hours with no updates (#39785).
// This probe needs the runtime itself to decrypt, dispatch and answer one cheap request.
export const SHARED_CONTROL_APP_HEARTBEAT_INTERVAL_MS = 30_000
// Above the 25s ws liveness window, so a dropped link is reported as a transport loss, not a stuck runtime.
export const SHARED_CONTROL_APP_HEARTBEAT_TIMEOUT_MS = 30_000

export type SharedControlAppHeartbeatOptions = {
  intervalMs?: number
  timeoutMs?: number
}

type Probe = (timeoutMs: number) => Promise<RuntimeRpcResponse<unknown>>

/**
 * One ready socket's app-level heartbeat. Any sealed frame from the runtime counts as an answer, so a busy
 * connection never sends a probe; only a socket silent for a whole interval sends one.
 */
export class SharedControlAppHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null
  private generation: number | null = null
  private lastAnswerAt = 0
  private lastTickAt = 0
  private probeInFlight = false
  private unresponsiveSince: number | null = null

  constructor(
    private readonly options: SharedControlAppHeartbeatOptions,
    private readonly args: {
      probe: Probe
      isCurrent: (generation: number) => boolean
      /** False skips probing, e.g. for an asleep or manually disconnected host. */
      shouldProbe: () => boolean
      /** The runtime missed a probe on this socket; retire it so reconnect backoff runs. */
      onUnresponsive: (generation: number) => void
      /** The runtime answered on a ready socket after it had been marked unresponsive. */
      onRecovered: () => void
      now?: () => number
    }
  ) {}

  /** Null until a probe misses; cleared only by a later answer on a ready socket, so it survives reconnects. */
  get unresponsiveAt(): number | null {
    return this.unresponsiveSince
  }

  start(generation: number): void {
    this.stop()
    this.generation = generation
    this.lastAnswerAt = this.lastTickAt = this.now()
    const intervalMs = this.options.intervalMs ?? SHARED_CONTROL_APP_HEARTBEAT_INTERVAL_MS
    this.timer = setInterval(() => this.tick(), intervalMs)
    // Why: mobile typechecks shared code with DOM timer types where unref is absent.
    const timer: unknown = this.timer
    if (
      typeof timer === 'object' &&
      timer !== null &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref()
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.timer = null
    this.generation = null
    this.probeInFlight = false
  }

  noteAnswer(): void {
    this.lastAnswerAt = this.now()
    // Why: before start() the frame is the handshake; after it, any sealed frame is the runtime answering.
    if (this.generation !== null && this.unresponsiveSince !== null) {
      this.unresponsiveSince = null
      this.args.onRecovered()
    }
  }

  private tick(): void {
    const generation = this.generation
    if (generation === null || this.probeInFlight || !this.args.isCurrent(generation)) {
      return
    }
    const intervalMs = this.options.intervalMs ?? SHARED_CONTROL_APP_HEARTBEAT_INTERVAL_MS
    const now = this.now()
    const sinceTickMs = now - this.lastTickAt
    this.lastTickAt = now
    // Why: a late tick means this process slept or stalled; socket liveness owns wake, so restart the window.
    if (sinceTickMs < 0 || sinceTickMs > intervalMs * 1.5) {
      this.lastAnswerAt = now
      return
    }
    if (now - this.lastAnswerAt < intervalMs || !this.args.shouldProbe()) {
      return
    }
    this.probeInFlight = true
    const timeoutMs = this.options.timeoutMs ?? SHARED_CONTROL_APP_HEARTBEAT_TIMEOUT_MS
    this.args.probe(timeoutMs).then(
      () => this.settle(generation, true),
      (error: unknown) => {
        // Why: a deadline that fired late means this process slept (Windows timers count through suspend).
        const late = this.now() - now > timeoutMs * 1.5
        this.settle(generation, isTimeout(error) && !late ? false : null)
      }
    )
  }

  /** answered: any reply (even an error) proves the runtime; false is a missed deadline; null is a socket loss. */
  private settle(generation: number, answered: boolean | null): void {
    if (this.generation !== generation || !this.args.isCurrent(generation)) {
      return
    }
    this.probeInFlight = false
    if (answered) {
      this.noteAnswer()
      return
    }
    if (answered === false) {
      this.unresponsiveSince ??= this.now()
      this.args.onUnresponsive(generation)
    }
  }

  private now(): number {
    return (this.args.now ?? Date.now)()
  }
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'runtime_timeout'
  )
}
