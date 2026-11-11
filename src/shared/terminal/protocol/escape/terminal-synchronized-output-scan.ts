/** Track DEC 2026 across renderer coalescing and main/relay drops; an open latch freezes xterm repaint until its 1s flush. */
export const SYNCHRONIZED_OUTPUT_START_SEQUENCE = '\x1b[?2026h'
export const SYNCHRONIZED_OUTPUT_END_SEQUENCE = '\x1b[?2026l'
export const SYNCHRONIZED_OUTPUT_MARKER_TAIL_CHARS = SYNCHRONIZED_OUTPUT_START_SEQUENCE.length - 1

export type SynchronizedOutputScan = {
  /** A start marker landed inside THIS chunk. */
  started: boolean
  /** An end marker landed inside THIS chunk. */
  ended: boolean
  /** Latch state after the chunk: true means a frame is still open. */
  active: boolean
  markerTail: string
}

// Carry split markers or a divided ?2026l can strand foreground coalescing and freeze the pane (#8754).
export function scanSynchronizedOutput(
  data: string,
  markerTail: string,
  wasActive: boolean
): SynchronizedOutputScan {
  const scanData = markerTail ? `${markerTail}${data}` : data
  const currentChunkStartIndex = scanData.length - data.length
  let active = wasActive
  let started = false
  let ended = false
  let startIndex = scanData.indexOf(SYNCHRONIZED_OUTPUT_START_SEQUENCE)
  let endIndex = scanData.indexOf(SYNCHRONIZED_OUTPUT_END_SEQUENCE)

  // Each marker search advances independently, so a missing counterpart is scanned only once.
  while (startIndex !== -1 || endIndex !== -1) {
    if (endIndex !== -1 && (startIndex === -1 || endIndex < startIndex)) {
      active = false
      if (endIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length > currentChunkStartIndex) {
        ended = true
      }
      endIndex = scanData.indexOf(
        SYNCHRONIZED_OUTPUT_END_SEQUENCE,
        endIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length
      )
      continue
    }
    active = true
    if (startIndex + SYNCHRONIZED_OUTPUT_START_SEQUENCE.length > currentChunkStartIndex) {
      started = true
    }
    startIndex = scanData.indexOf(
      SYNCHRONIZED_OUTPUT_START_SEQUENCE,
      startIndex + SYNCHRONIZED_OUTPUT_START_SEQUENCE.length
    )
  }

  return {
    started,
    ended,
    active,
    // Why length-1: a full marker can never hide in the tail, so no marker is counted twice.
    markerTail: scanData.slice(-SYNCHRONIZED_OUTPUT_MARKER_TAIL_CHARS)
  }
}

export type SynchronizedOutputLatchState = {
  markerTail: string
  active: boolean
}

export const INITIAL_SYNCHRONIZED_OUTPUT_LATCH_STATE: SynchronizedOutputLatchState = {
  markerTail: '',
  active: false
}

/** Carry a closing sequence with delivered output when dropped bytes leave the frame open; one early repaint avoids repeated 1s stalls. */
export function advanceDroppedSynchronizedOutputLatch(
  data: string,
  previous: SynchronizedOutputLatchState
): { data: string; state: SynchronizedOutputLatchState } {
  const scan = scanSynchronizedOutput(data, previous.markerTail, previous.active)
  return {
    data: scan.active ? SYNCHRONIZED_OUTPUT_END_SEQUENCE : '',
    state: { markerTail: scan.markerTail, active: scan.active }
  }
}

/** Prefer splits outside DEC 2026 frames and avoid severing markers; reset profiles release latches when a safe split cannot fit.
 * Current callers omit markerTail/wasActive, so buffers starting inside a frame get only best-effort alignment. */
export function resolveSynchronizedOutputSafeSplit(
  data: string,
  limit: number,
  markerTail = '',
  wasActive = false
): number {
  if (data.length <= limit) {
    return data.length
  }
  // Cut before an ESC whose marker cannot finish by the limit.
  let candidate = limit
  const guardStart = Math.max(0, limit - SYNCHRONIZED_OUTPUT_MARKER_TAIL_CHARS)
  const escapeIndex = data.lastIndexOf('\x1b', limit - 1)
  if (
    escapeIndex >= guardStart &&
    limit - escapeIndex < SYNCHRONIZED_OUTPUT_START_SEQUENCE.length
  ) {
    candidate = escapeIndex
  }
  if (!scanSynchronizedOutput(data.slice(0, candidate), markerTail, wasActive).active) {
    return candidate > 0 ? candidate : limit
  }
  const lastClose = data.lastIndexOf(
    SYNCHRONIZED_OUTPUT_END_SEQUENCE,
    Math.max(0, candidate - SYNCHRONIZED_OUTPUT_END_SEQUENCE.length)
  )
  if (lastClose === -1) {
    // An oversized frame cannot fit; reset profiles must release its latch.
    return candidate > 0 ? candidate : limit
  }
  const aligned = lastClose + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length
  // Below half the window, preserve throughput: main requeues the remainder for a later round, so tiny aligned chunks waste its budget. Reset profiles release the latch.
  return aligned * 2 >= limit ? aligned : candidate > 0 ? candidate : limit
}
