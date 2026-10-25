/**
 * DEC mode 2026 (synchronized output) latch tracking.
 *
 * Why this module is shared: like terminal-mode-reset-profiles, the latch is a
 * terminal-protocol contract rather than a renderer concern. xterm stops
 * repainting while the latch is open and force-flushes only after a 1000ms
 * timeout, so whichever side of the PTY relay last touched a pane's bytes has
 * to know whether it left a frame open — main's drop paths included, not just
 * the renderer's foreground coalescer.
 */
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

// Why the carried tail: a PTY relay can split \x1b[?2026l across chunks; scanning the raw
// chunk alone left the foreground DEC 2026 latch stuck open so every later chunk was
// held instead of coalesced, freezing the visible pane (#8754).
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

/**
 * Advances the latch across bytes the renderer will never receive.
 *
 * Returns the sequence that must ride along with whatever IS delivered so the
 * pane is not left mid-frame: a drop that swallowed the closing marker would
 * otherwise leave xterm painting nothing until its 1000ms forced flush, once
 * per frame, for as long as the condition lasts. Closing a frame early only
 * costs one premature repaint; leaving it open costs a full second of blank
 * screen, so the asymmetry favours always closing.
 */
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

/**
 * Chooses a split point that does not leave the delivered half inside an open
 * DEC 2026 frame.
 *
 * A blind byte-offset split puts `\x1b[?2026h` in one chunk and its
 * `\x1b[?2026l` in the next, so xterm stops repainting until the remainder is
 * delivered on a later flush — behind every other pane's output — or until its
 * 1000ms forced flush. It can also sever the 8-byte marker itself.
 *
 * Returns the largest length <= `limit` that ends outside an open frame, or
 * `limit` when no such point exists (a frame genuinely longer than the window;
 * the latch release still rides along via the reset profiles).
 *
 * KNOWN LIMITATION: no caller threads `markerTail`/`wasActive`, so a buffer that
 * begins INSIDE an already-open frame is scanned as if closed. That degrades to
 * the blind offset this replaced — never worse, and byte-exact either way — but
 * it means cross-chunk alignment is best-effort. Threading per-PTY latch state
 * through the split sites would close it.
 */
export function resolveSynchronizedOutputSafeSplit(
  data: string,
  limit: number,
  markerTail = '',
  wasActive = false
): number {
  if (data.length <= limit) {
    return data.length
  }
  // Step 1: never hand over a severed marker. If an ESC near the boundary cannot
  // have completed by `limit`, cut before it instead.
  let candidate = limit
  const guardStart = Math.max(0, limit - SYNCHRONIZED_OUTPUT_MARKER_TAIL_CHARS)
  const escapeIndex = data.lastIndexOf('\x1b', limit - 1)
  if (
    escapeIndex >= guardStart &&
    limit - escapeIndex < SYNCHRONIZED_OUTPUT_START_SEQUENCE.length
  ) {
    candidate = escapeIndex
  }
  // Step 2: the delivered half must not end inside an open frame.
  if (!scanSynchronizedOutput(data.slice(0, candidate), markerTail, wasActive).active) {
    return candidate > 0 ? candidate : limit
  }
  // Fall back to the last frame close that ENDS at or before the candidate.
  const lastClose = data.lastIndexOf(
    SYNCHRONIZED_OUTPUT_END_SEQUENCE,
    Math.max(0, candidate - SYNCHRONIZED_OUTPUT_END_SEQUENCE.length)
  )
  if (lastClose === -1) {
    // One frame is longer than the window; deliver the window and let the
    // reset profiles release the latch.
    return candidate > 0 ? candidate : limit
  }
  const aligned = lastClose + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length
  // Why the floor: a caller that cannot refill the shortfall in the same round
  // (main's flush re-queues the remainder with eligibleRound = round + 1) would
  // lose up to half its per-PTY throughput when frames land just past the
  // midpoint. Below the floor, prefer throughput and let the reset profiles
  // release the latch.
  return aligned * 2 >= limit ? aligned : candidate > 0 ? candidate : limit
}
