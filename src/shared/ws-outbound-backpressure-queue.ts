// Why: both the server reply path (e2ee-channel) and the client send path
// (remote-runtime-client) write to a ws with no backpressure handling. A fast
// producer over a slow link balloons ws.bufferedAmount / RSS without bound, or
// (binary path) silently drops frames. This queue holds outbound frames in
// order while bufferedAmount is over a soft cap and flushes as it drains, so no
// frame is dropped or reordered. It only signals overflow when a hard byte
// bound is exceeded (the link is effectively dead), letting the caller force a
// clean reconnect/resync instead of growing memory without limit.
//
// Generic over the frame type so it serves both the text reply path (encrypted
// base64 strings) and the binary send path (Uint8Array frames).

export type WsOutboundBackpressureQueueOptions<TFrame> = {
  /** Send a frame on the wire. Called only when under the soft cap. */
  send: (frame: TFrame) => void
  /** Serialized byte length of a frame, for cap accounting. */
  byteLengthOf: (frame: TFrame) => number
  /** Current ws.bufferedAmount in bytes. */
  getBufferedAmount: () => number
  /** True when the socket can still accept sends (OPEN and keyed). */
  isWritable: () => boolean
  /**
   * Called once when queued bytes exceed maxQueuedBytes — the link is wedged.
   * The caller should tear the connection down so a fresh subscription can
   * replay an authoritative snapshot. The queue drops its backlog afterward.
   */
  onOverflow: () => void
  /** Soft cap: stop draining onto the wire while bufferedAmount is above this. */
  softCapBytes?: number
  /** Hard cap on bytes held in this queue before onOverflow fires. */
  maxQueuedBytes?: number
  /** Poll interval used to re-check bufferedAmount while parked. */
  drainPollMs?: number
  /** Injectable scheduler for deterministic tests. */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export type WsOutboundBackpressureQueue<TFrame> = {
  /** Queue-or-send a frame. Preserves order across all prior frames. */
  enqueue: (frame: TFrame) => void
  /** Bytes currently held (not yet handed to the wire). */
  queuedBytes: () => number
  /** Drop the backlog and stop the drain timer (call on close). */
  dispose: () => void
}

const DEFAULT_SOFT_CAP_BYTES = 8 * 1024 * 1024
// Why: tolerate a large transient burst (e.g. a build log spike) before
// declaring the link dead; 64 MiB is ~8x the soft cap yet still bounds RSS.
const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024
const DEFAULT_DRAIN_POLL_MS = 25

export function createWsOutboundBackpressureQueue<TFrame>(
  options: WsOutboundBackpressureQueueOptions<TFrame>
): WsOutboundBackpressureQueue<TFrame> {
  const softCapBytes = options.softCapBytes ?? DEFAULT_SOFT_CAP_BYTES
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
  const drainPollMs = options.drainPollMs ?? DEFAULT_DRAIN_POLL_MS
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))

  // Why: a ws without a numeric bufferedAmount (some mocks/transports) must not
  // strand frames in the queue forever; treat unknown backpressure as "clear".
  const bufferedAmount = (): number => {
    const value = options.getBufferedAmount()
    return Number.isFinite(value) ? value : 0
  }

  const queue: { frame: TFrame; bytes: number }[] = []
  let queueHead = 0
  let queued = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let overflowed = false
  let disposed = false

  const stopTimer = (): void => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  const dropBacklog = (): void => {
    queue.length = 0
    queueHead = 0
    queued = 0
    stopTimer()
  }

  // Drain as many queued frames as the wire will take without crossing the
  // soft cap; re-arm the poll timer if frames remain.
  const drain = (): void => {
    if (disposed || overflowed) {
      return
    }
    if (!options.isWritable()) {
      // Socket went away mid-park; let the transport's own close path clean up.
      dropBacklog()
      return
    }
    while (queueHead < queue.length && bufferedAmount() <= softCapBytes) {
      const entry = queue[queueHead++]
      queued -= entry.bytes
      options.send(entry.frame)
    }
    if (queueHead < queue.length) {
      timer = setTimer(drain, drainPollMs)
    } else {
      // Why: resetting the drained array keeps enqueue/drain O(1) per frame;
      // repeated Array.shift() would make recovery from a large backlog O(n²).
      queue.length = 0
      queueHead = 0
      stopTimer()
    }
  }

  return {
    enqueue(frame: TFrame): void {
      if (disposed || overflowed) {
        return
      }
      // Fast path: nothing parked and the wire is under the cap — send directly.
      if (queueHead === queue.length && options.isWritable() && bufferedAmount() <= softCapBytes) {
        options.send(frame)
        return
      }
      const bytes = options.byteLengthOf(frame)
      queue.push({ frame, bytes })
      queued += bytes
      if (queued > maxQueuedBytes) {
        overflowed = true
        dropBacklog()
        options.onOverflow()
        return
      }
      if (timer === null) {
        timer = setTimer(drain, drainPollMs)
      }
    },
    queuedBytes: () => queued,
    dispose(): void {
      disposed = true
      dropBacklog()
    }
  }
}
