import { skipOpenEscapeContinuation } from '../../../../shared/terminal-partial-escape-tail'

const CAN = '\x18'

export type ResumeEscapeChunk = {
  data: string
  /** Seq where main's delivery starts; undefined when the stream is unmetered. */
  startSeq: number | undefined
  /** True when `data` is the whole delivered chunk or an exact raw suffix, so startSeq is trustworthy. */
  mappable: boolean
  gapEscapeState: string | undefined
}

export type ResumeEscapeParserState = {
  /** End seq of application bytes xterm has received; null when unknown. */
  paintedSeq: number | null
  /** xterm's open escape boundary; '' when grounded. */
  parserEscape: string
}

/** Keeps xterm's parser aligned with the app stream where it resumes after a byte gap or a renderer-written CAN. */
export class TerminalResumeEscapeGap {
  private grounded = false
  private abortedEscape = ''
  private skipCarry = ''
  private streamId: string | null = null

  /** Call before writing a CAN-led reset; keeps the first aborted escape until app bytes resume. */
  noteGroundingWrite(parserEscape: string): void {
    if (!this.grounded) {
      this.abortedEscape = parserEscape
    }
    this.grounded = true
  }

  /** Replay, PTY change or PTY exit: parser state no longer descends from earlier app bytes. */
  reset(): void {
    this.grounded = false
    this.abortedEscape = ''
    this.skipCarry = ''
  }

  /** Clears state carried over from a previous PTY; state recorded before the first bind belongs to this stream. */
  bindStream(streamId: string | null): void {
    if (this.streamId !== null && streamId !== this.streamId) {
      this.reset()
    }
    this.streamId = streamId
  }

  admit(chunk: ResumeEscapeChunk, parser: ResumeEscapeParserState): string {
    const { grounded, abortedEscape, skipCarry } = this
    this.grounded = false
    this.abortedEscape = ''
    this.skipCarry = ''
    const label = chunk.gapEscapeState ?? ''
    // After our own CAN the parser is ground, and main computed the label over these exact delivered bytes.
    if (grounded && label) {
      return this.skip(label, chunk.data)
    }
    const { startSeq } = chunk
    if (!chunk.mappable || startSeq === undefined || parser.paintedSeq === null) {
      // Unproven ordering or unmappable text never deletes bytes.
      return chunk.data
    }
    if (startSeq === parser.paintedSeq) {
      const open = skipCarry || abortedEscape
      return open ? this.skip(open, chunk.data) : chunk.data
    }
    // A parser already holding the label's prefix (replay tail, sentinel) completes the escape instead.
    if (startSeq < parser.paintedSeq || !label || parser.parserEscape === label) {
      return chunk.data
    }
    // Ground a stale pre-gap escape after skipping so the scanner never consumes our own CAN.
    const rest = this.skip(label, chunk.data)
    return parser.parserEscape ? `${CAN}${rest}` : rest
  }

  private skip(open: string, data: string): string {
    const skipped = skipOpenEscapeContinuation(open, data)
    this.skipCarry = skipped.stillOpen
    return skipped.rest
  }
}
