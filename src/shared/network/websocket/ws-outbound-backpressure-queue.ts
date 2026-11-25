// Share FIFO backpressure for text replies and binary client frames. Bound retained memory; overflow asks the caller to reconnect/resync instead of silently dropping frames.

/** Failure reason and retained backlog before cleanup. */
export type WsOutboundOverflowEvidence = {
  cap: 'maxQueuedBytes' | 'maxQueuedFrames' | 'maxFrameBytes' | 'claimQueuedBytes' | 'sendFailed'
  queuedBytes: number
  queuedFrames: number
  maxQueuedBytes: number
  maxQueuedFrames: number
  maxFrameBytes: number
}

export type WsOutboundBackpressureQueueOptions<TFrame> = {
  /** Send only while the wire is at or below the soft cap. */
  send: (frame: TFrame) => void
  /** Serialized byte length of a frame, for cap accounting. */
  byteLengthOf: (frame: TFrame) => number
  /** Current ws.bufferedAmount in bytes. */
  getBufferedAmount: () => number
  /** True when the socket can still accept sends (OPEN and keyed). */
  isWritable: () => boolean
  /** Optional process-wide native-buffer admission check. */
  canSend?: (frameBytes: number, alreadyRetained: boolean) => boolean
  /** Called once on limit/admission/send failure, after backlog cleanup; evidence retains pre-drop counts. Reconnect and replay an authoritative snapshot. */
  onOverflow: (evidence: WsOutboundOverflowEvidence) => void
  /** Park draining while bufferedAmount exceeds this threshold. */
  softCapBytes?: number
  /** Hard cap on bytes held in this queue before onOverflow fires. */
  maxQueuedBytes?: number
  /** Hard cap for one frame, including the direct-send fast path. */
  maxFrameBytes?: number
  /** Hard cap on frames so zero/tiny-frame floods cannot bypass the byte cap. */
  maxQueuedFrames?: number
  drainPollMs?: number
  /** Maximum frames handed to the native socket in one event-loop turn. */
  maxDrainFramesPerTurn?: number
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
  /** True when nothing is parked and the wire has room, so enqueue would send this size directly. */
  isIdle: (frameBytes: number) => boolean
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
// Allow transient build-log bursts while bounding retained memory to eight times the default soft cap.
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
  const configuredDrainFramesPerTurn = options.maxDrainFramesPerTurn
  const maxDrainFramesPerTurn =
    typeof configuredDrainFramesPerTurn === 'number' &&
    Number.isSafeInteger(configuredDrainFramesPerTurn) &&
    configuredDrainFramesPerTurn > 0
      ? configuredDrainFramesPerTurn
      : Number.POSITIVE_INFINITY
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))

  // Treat unknown/non-finite backpressure as clear so mocks/other transports cannot strand frames.
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

  const failOverflow = (cap: WsOutboundOverflowEvidence['cap']): void => {
    if (disposed || overflowed) {
      return
    }
    overflowed = true
    // Snapshot before dropBacklog() zeroes the counters.
    const evidence: WsOutboundOverflowEvidence = {
      cap,
      queuedBytes: queued,
      queuedFrames,
      maxQueuedBytes,
      maxQueuedFrames,
      maxFrameBytes
    }
    dropBacklog()
    options.onOverflow(evidence)
  }

  const sendFrame = (frame: TFrame): boolean => {
    try {
      options.send(frame)
      return true
    } catch {
      failOverflow('sendFailed')
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
    let drainedFrames = 0
    while (
      queuedFrames > 0 &&
      drainedFrames < maxDrainFramesPerTurn &&
      bufferedAmount() <= softCapBytes &&
      (options.canSend?.(queue[queueHead]!.bytes, true) ?? true)
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
      drainedFrames += 1
    }
    if (queuedFrames > 0) {
      const nextDrainDelay = drainedFrames >= maxDrainFramesPerTurn ? 0 : drainPollMs
      timer = setTimer(drain, nextDrainDelay)
    } else {
      // Use a head index rather than repeated shifts to avoid quadratic backlog recovery.
      resetDrainedQueue()
    }
  }

  const isIdle = (bytes: number): boolean =>
    queuedFrames === 0 &&
    options.isWritable() &&
    bufferedAmount() <= softCapBytes &&
    (options.canSend?.(bytes, false) ?? true)

  const enqueueCancelable = (frame: TFrame): WsOutboundEnqueueResult => {
    if (disposed || overflowed) {
      return { accepted: false, queued: false, cancel: () => false }
    }
    const bytes = options.byteLengthOf(frame)
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > maxFrameBytes) {
      failOverflow('maxFrameBytes')
      return { accepted: false, queued: false, cancel: () => false }
    }
    if (isIdle(bytes)) {
      return {
        accepted: sendFrame(frame),
        queued: false,
        cancel: () => false
      }
    }
    const queuedBytesClaim = options.claimQueuedBytes?.(bytes)
    if (options.claimQueuedBytes && !queuedBytesClaim) {
      failOverflow('claimQueuedBytes')
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
      failOverflow(queued > maxQueuedBytes ? 'maxQueuedBytes' : 'maxQueuedFrames')
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
    isIdle,
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
