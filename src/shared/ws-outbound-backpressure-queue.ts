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
  /** Optional process-wide native-buffer admission check. */
  canSend?: (frameBytes: number) => boolean
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
  /** Hard cap for one frame, including the direct-send fast path. */
  maxFrameBytes?: number
  /** Hard cap on frames so zero/tiny-frame floods cannot bypass the byte cap. */
  maxQueuedFrames?: number
  /** Poll interval used to re-check bufferedAmount while parked. */
  drainPollMs?: number
  /** Process-wide admission for frames retained in this JavaScript queue. */
  claimQueuedBytes?: (bytes: number) => (() => void) | null
  /** Injectable scheduler for deterministic tests. */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export type WsOutboundBackpressureQueue<TFrame> = {
  /** Queue-or-send a frame. Preserves order across all prior frames. */
  enqueue: (frame: TFrame) => boolean
  /** Queue-or-send a frame and allow its owner to cancel it before wire delivery. */
  enqueueCancelable: (frame: TFrame) => WsOutboundEnqueueResult
  /** Bytes currently held (not yet handed to the wire). */
  queuedBytes: () => number
  evidence: () => { queuedBytes: number; queuedFrames: number; storageSlots: number }
  /** Drop the backlog and stop the drain timer (call on close). */
  dispose: () => void
}

export type WsOutboundEnqueueResult = {
  accepted: boolean
  queued: boolean
  cancel: () => boolean
}

const DEFAULT_SOFT_CAP_BYTES = 8 * 1024 * 1024
// Why: tolerate a large transient burst (e.g. a build log spike) before
// declaring the link dead; 64 MiB is ~8x the soft cap yet still bounds RSS.
const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_QUEUED_FRAMES = 4_096
const DEFAULT_DRAIN_POLL_MS = 25
const QUEUE_COMPACTION_HEAD_THRESHOLD = 64

export function createWsOutboundBackpressureQueue<TFrame>(
  options: WsOutboundBackpressureQueueOptions<TFrame>
): WsOutboundBackpressureQueue<TFrame> {
  const softCapBytes = options.softCapBytes ?? DEFAULT_SOFT_CAP_BYTES
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
  const maxFrameBytes = options.maxFrameBytes ?? maxQueuedBytes
  const maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES
  const drainPollMs = options.drainPollMs ?? DEFAULT_DRAIN_POLL_MS
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))

  // Why: a ws without a numeric bufferedAmount (some mocks/transports) must not
  // strand frames in the queue forever; treat unknown backpressure as "clear".
  const bufferedAmount = (): number => {
    const value = options.getBufferedAmount()
    return Number.isFinite(value) ? value : 0
  }

  type QueueEntry = {
    frame: TFrame | null
    bytes: number
    releaseQueuedBytes: () => void
    retained: boolean
  }

  const queue: (QueueEntry | undefined)[] = []
  let queueHead = 0
  let queued = 0
  let queuedFrames = 0
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
    while (queueHead < queue.length) {
      const entry = queue[queueHead++]
      if (entry?.retained) {
        entry.retained = false
        entry.frame = null
        entry.releaseQueuedBytes()
      }
    }
    queue.length = 0
    queueHead = 0
    queued = 0
    queuedFrames = 0
    stopTimer()
  }

  const failOverflow = (): void => {
    if (disposed || overflowed) {
      return
    }
    overflowed = true
    dropBacklog()
    options.onOverflow()
  }

  const sendFrame = (frame: TFrame): boolean => {
    try {
      options.send(frame)
      return true
    } catch {
      failOverflow()
      return false
    }
  }

  const advanceQueueHead = (): void => {
    while (queueHead < queue.length && !queue[queueHead]?.retained) {
      queueHead += 1
    }
  }

  const resetDrainedQueue = (): void => {
    queue.length = 0
    queueHead = 0
    stopTimer()
  }

  const releaseEntry = (entry: QueueEntry): boolean => {
    if (!entry.retained) {
      return false
    }
    entry.retained = false
    entry.frame = null
    queued -= entry.bytes
    queuedFrames -= 1
    entry.releaseQueuedBytes()
    return true
  }

  const cancelEntry = (entry: QueueEntry): boolean => {
    if (!releaseEntry(entry)) {
      return false
    }
    const index = queue.indexOf(entry, queueHead)
    if (index !== -1) {
      queue[index] = undefined
    }
    advanceQueueHead()
    if (queuedFrames === 0) {
      resetDrainedQueue()
    }
    return true
  }

  // Drain as many queued frames as the wire will take without crossing the
  // soft cap; re-arm the poll timer if frames remain.
  const drain = (): void => {
    timer = null
    if (disposed || overflowed) {
      return
    }
    if (!options.isWritable()) {
      // Socket went away mid-park; let the transport's own close path clean up.
      dropBacklog()
      return
    }
    advanceQueueHead()
    while (
      queuedFrames > 0 &&
      bufferedAmount() <= softCapBytes &&
      (options.canSend?.(queue[queueHead]!.bytes) ?? true)
    ) {
      const entry = queue[queueHead++]!
      queue[queueHead - 1] = undefined
      const frame = entry.frame!
      releaseEntry(entry)
      advanceQueueHead()
      if (queueHead >= QUEUE_COMPACTION_HEAD_THRESHOLD) {
        queue.splice(0, queueHead)
        queueHead = 0
      }
      if (!sendFrame(frame)) {
        return
      }
    }
    if (queuedFrames > 0) {
      timer = setTimer(drain, drainPollMs)
    } else {
      // Why: resetting the drained array keeps enqueue/drain O(1) per frame;
      // repeated Array.shift() would make recovery from a large backlog O(n²).
      resetDrainedQueue()
    }
  }

  const enqueueCancelable = (frame: TFrame): WsOutboundEnqueueResult => {
    if (disposed || overflowed) {
      return { accepted: false, queued: false, cancel: () => false }
    }
    const bytes = options.byteLengthOf(frame)
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > maxFrameBytes) {
      failOverflow()
      return { accepted: false, queued: false, cancel: () => false }
    }
    // Fast path: nothing parked and the wire is under the cap — send directly.
    if (
      queuedFrames === 0 &&
      options.isWritable() &&
      bufferedAmount() <= softCapBytes &&
      (options.canSend?.(bytes) ?? true)
    ) {
      return {
        accepted: sendFrame(frame),
        queued: false,
        cancel: () => false
      }
    }
    const queuedBytesClaim = options.claimQueuedBytes?.(bytes)
    if (options.claimQueuedBytes && !queuedBytesClaim) {
      failOverflow()
      return { accepted: false, queued: false, cancel: () => false }
    }
    const entry: QueueEntry = {
      frame,
      bytes,
      releaseQueuedBytes: queuedBytesClaim ?? (() => undefined),
      retained: true
    }
    queue.push(entry)
    queued += bytes
    queuedFrames += 1
    if (queued > maxQueuedBytes || queuedFrames > maxQueuedFrames) {
      failOverflow()
      return { accepted: false, queued: false, cancel: () => false }
    }
    if (timer === null) {
      timer = setTimer(drain, drainPollMs)
    }
    return {
      accepted: true,
      queued: true,
      cancel: () => cancelEntry(entry)
    }
  }

  return {
    enqueue(frame: TFrame): boolean {
      return enqueueCancelable(frame).accepted
    },
    enqueueCancelable,
    queuedBytes: () => queued,
    evidence: () => ({
      queuedBytes: queued,
      queuedFrames,
      storageSlots: queue.length
    }),
    dispose(): void {
      disposed = true
      dropBacklog()
    }
  }
}
