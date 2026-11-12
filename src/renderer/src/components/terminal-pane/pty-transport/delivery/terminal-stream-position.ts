import {
  MAX_PARTIAL_ESCAPE_TAIL_LENGTH,
  extractPartialEscapeTail
} from '../../../../../../shared/terminal/protocol/escape/terminal-partial-escape-tail'
import type { PtyDataMeta } from './pty-dispatcher'

const CAN = '\x18'

// Deliveries with an unknown start (bytes before them were lost) skipped before resuming anyway: a
// gap no snapshot repairs (restore unavailable, plain output that never reaches an escape) must not
// freeze the pane. A start main knows is inside an escape is never released this way; main sees
// that escape end, so a proven delivery always follows.
const MAX_SKIPPED_UNKNOWN_DELIVERIES = 4

/** Where a delivery sits in its PTY's output stream, in main's raw sequence domain. */
export type StreamDelivery = {
  /** Seq of the delivery's first byte; undefined for streams without a char-sequence domain. */
  startSeq: number | undefined
  endSeq: number | undefined
  /** Main proved the stream's escape parser is at ground where this delivery starts. */
  startsAtGround: boolean
  /** Bytes before this delivery were lost, so main cannot tell whether an escape is open. */
  boundaryUnknown: boolean
  /**
   * For a suffix the renderer cut from a chunk: the incomplete escape the cut-off bytes end in;
   * absent when they end at ground or their state is unknown.
   */
  cutEscapeTail?: string
}

/**
 * Where xterm's parser stands in one PTY's output stream. Application bytes may enter xterm only
 * where xterm already is: as an exact continuation of the bytes it parsed (a split escape completes
 * correctly) or from a point main proves is an escape boundary. Anything else follows lost bytes
 * and could begin inside an escape whose start xterm never saw, printing its tail as text (`43B`
 * from `ESC[43B`); it is skipped whole, never trimmed, and the pane's restore repaints it.
 */
export class TerminalStreamPosition {
  private ptyId: string | null = null
  // null until a replay or a proven delivery locates xterm in this stream.
  private seq: number | null = null
  // xterm's parser state equals the stream's at `seq`.
  private exact = false
  // xterm's parser is known to be at ground: it parsed nothing yet, or Orca's own CAN-led write last.
  private grounded = true
  private skippedUnknown = 0
  // The escape tail re-armed by the replay that set `seq` ('' for none); null after stream bytes.
  private replayedEscapeTail: string | null = null

  /**
   * A replay (snapshot plus its pending escape tail) left xterm exactly at `seq`. A replay passes
   * the tail it re-armed, '' for none, so a cut at `seq` can re-arm one its snapshot omitted.
   */
  anchor(ptyId: string, seq: number, replayedEscapeTail?: string): void {
    this.ptyId = ptyId
    this.seq = seq
    this.exact = true
    this.grounded = false
    this.skippedUnknown = 0
    this.replayedEscapeTail = replayedEscapeTail ?? null
  }

  /** The stream's seq domain ended (exit, PTY replacement, a restarted counter); xterm keeps its parser state. */
  reset(ptyId: string | null = this.ptyId): void {
    if (ptyId !== this.ptyId) {
      return
    }
    this.seq = null
    this.exact = false
    this.skippedUnknown = 0
  }

  /**
   * Bytes outside the stream moved xterm's parser off it. `grounded` when they were a CAN-led
   * reset or warning, which leaves the parser at ground; otherwise its state is unknown.
   */
  invalidate(options: { grounded: boolean } = { grounded: false }): void {
    this.exact = false
    this.grounded = options.grounded
  }

  /**
   * The bytes to write for a delivery, or null to skip it. Resuming at a proven boundary first
   * grounds xterm's parser with CAN so a stale escape cannot swallow the delivery.
   */
  admit(ptyId: string, data: string, delivery: StreamDelivery): string | null {
    const { startSeq, endSeq } = delivery
    if (this.ptyId !== ptyId) {
      this.ptyId = ptyId
      this.reset()
    }
    if (startSeq === undefined || endSeq === undefined) {
      // Unlocated: a stream without a char-sequence domain writes as before, a renderer cut does not.
      if (!delivery.boundaryUnknown) {
        // Unlocated bytes move xterm's parser without moving the position.
        if (data) {
          this.invalidate()
        }
        return data
      }
    } else if (this.seq === null && startSeq === 0) {
      // A stream's first byte starts at ground; ground xterm too unless it already is.
      const wasGrounded = this.grounded
      this.anchor(ptyId, endSeq)
      return wasGrounded ? data : `${CAN}${data}`
    } else if (this.seq !== null && this.exact && startSeq <= this.seq) {
      // An exact continuation, or an overlap with bytes xterm already parsed. A snapshot can omit
      // the escape open at its seq (#33766); a chunk cut there still holds that escape's start, so
      // re-arm it from those bytes as the snapshot's pending tail would have.
      const rearm =
        startSeq === this.seq && this.replayedEscapeTail === ''
          ? (delivery.cutEscapeTail ?? '')
          : ''
      this.anchor(ptyId, endSeq)
      return `${rearm}${data}`
    }
    const releaseUnknown =
      delivery.boundaryUnknown && this.skippedUnknown >= MAX_SKIPPED_UNKNOWN_DELIVERIES
    if (!delivery.startsAtGround && !releaseUnknown) {
      if (delivery.boundaryUnknown) {
        this.skippedUnknown += 1
      }
      return null
    }
    const wasGrounded = this.grounded
    if (endSeq === undefined) {
      this.invalidate()
      this.skippedUnknown = 0
    } else {
      this.anchor(ptyId, endSeq)
    }
    // Ground whatever xterm holds, including escapes a mirror cannot see (C1 controls).
    return wasGrounded ? data : `${CAN}${data}`
  }
}

/**
 * The stream position of `data`, which is either the delivered chunk or a suffix of it (a restore
 * slice or a carved-off query). Main's boundary flags describe the chunk's first byte only.
 */
export function streamDeliveryOf(
  data: string,
  delivered: {
    data: string
    seq?: number
    rawLength?: number
    midEscape?: true | 'unknown'
  },
  options: { seqCountsChars: boolean }
): StreamDelivery {
  const whole = data === delivered.data
  const endSeq = delivered.seq
  if (!options.seqCountsChars || typeof endSeq !== 'number') {
    // No char-sequence domain: only a cut the renderer itself flagged is treated as following a gap.
    return {
      startSeq: undefined,
      endSeq: undefined,
      startsAtGround: !delivered.midEscape,
      boundaryUnknown: delivered.midEscape === 'unknown'
    }
  }
  const rawLength = delivered.rawLength ?? delivered.data.length
  if (!whole && rawLength !== delivered.data.length) {
    // A suffix of a transformed chunk has no exact raw position; never fabricate one.
    return { startSeq: undefined, endSeq: undefined, startsAtGround: false, boundaryUnknown: true }
  }
  const cutEscapeTail = whole ? '' : escapeTailBeforeCut(data, delivered)
  return {
    startSeq: endSeq - (whole ? rawLength : data.length),
    endSeq,
    startsAtGround: whole && !delivered.midEscape,
    boundaryUnknown: !whole || delivered.midEscape === 'unknown',
    ...(cutEscapeTail ? { cutEscapeTail } : {})
  }
}

/**
 * The incomplete escape the bytes cut off before `data` end in, '' when none is known. The scan
 * starts where the state is known: the chunk's start when main proved it is at ground, otherwise
 * the cut-off bytes' first ESC, past which the state no longer depends on what preceded it.
 * Cut-off bytes holding an 8-bit C1 control are not scanned; main's boundary tracking does not
 * follow C1 either.
 */
function escapeTailBeforeCut(
  data: string,
  delivered: { data: string; midEscape?: true | 'unknown' }
): string {
  if (!delivered.data.endsWith(data)) {
    return ''
  }
  const cutOff = delivered.data.slice(0, delivered.data.length - data.length)
  const from = delivered.midEscape ? cutOff.indexOf('\x1b') : 0
  if (from === -1 || /[\u0080-\u009f]/.test(cutOff)) {
    return ''
  }
  const tail = extractPartialEscapeTail(cutOff.slice(from))
  return tail.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH ? '' : tail
}

/**
 * Metadata for the kept tail of a chunk whose head was dropped: the tail keeps its true raw range
 * when chars map 1:1 onto the stream, otherwise it loses its position. Either way it starts after
 * lost bytes, at an unknown escape boundary, and needs a restore.
 */
export function keptSuffixMeta(
  meta: PtyDataMeta | undefined,
  originalLength: number,
  keptLength: number
): PtyDataMeta {
  const next: PtyDataMeta = {
    ...meta,
    droppedOutput: true,
    midEscape: 'unknown'
  }
  if ((meta?.rawLength ?? originalLength) === originalLength) {
    next.rawLength = keptLength
  } else {
    delete next.seq
    delete next.rawLength
  }
  return next
}

/** Main's drop sentinel: Orca's recovery bytes (salvaged queries, mode releases), not stream bytes. */
export function isDropSentinelMeta(meta: PtyDataMeta | undefined): boolean {
  return meta?.droppedOutput === true && !meta.midEscape
}

/** Mark a kept chunk that follows evicted bytes; main's drop sentinel stays recovery bytes. */
export function markedAfterEviction(meta: PtyDataMeta | undefined): PtyDataMeta {
  if (meta && isDropSentinelMeta(meta)) {
    return meta
  }
  return { ...meta, droppedOutput: true, midEscape: 'unknown' }
}
