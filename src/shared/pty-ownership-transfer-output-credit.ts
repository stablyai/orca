import type { PtyOwnershipTransferOutputFrame } from './pty-ownership-transfer-wire'

export const PTY_OWNERSHIP_TRANSFER_OUTPUT_CREDIT_DEFAULT_WINDOW_BYTES = 512 * 1024
export const PTY_OWNERSHIP_TRANSFER_OUTPUT_CREDIT_MAX_WINDOW_BYTES = 2 * 1024 * 1024
export const PTY_OWNERSHIP_TRANSFER_OUTPUT_CREDIT_DEFAULT_WINDOW_FRAMES = 256
export const PTY_OWNERSHIP_TRANSFER_OUTPUT_CREDIT_MAX_WINDOW_FRAMES = 1_024

type SentFrame = Readonly<{
  seq: number
  data: string
  bytes: number
}>

export type PtyOwnershipTransferOutputCreditAcknowledgement = Readonly<{
  throughSeq: number
  acknowledgedBytes: number
  inFlightBytes: number
}>

/** Tracks one bounded cumulative-ACK window without owning source replay retention. */
export class PtyOwnershipTransferOutputCreditWindow {
  readonly windowBytes: number
  readonly windowFrames: number
  private acknowledgedThroughSeq = 0
  private inFlightBytes = 0
  private sent: SentFrame[] = []

  constructor(
    windowBytes: number,
    windowFrames = PTY_OWNERSHIP_TRANSFER_OUTPUT_CREDIT_DEFAULT_WINDOW_FRAMES
  ) {
    if (
      !Number.isSafeInteger(windowBytes) ||
      windowBytes <= 0 ||
      windowBytes > PTY_OWNERSHIP_TRANSFER_OUTPUT_CREDIT_MAX_WINDOW_BYTES
    ) {
      throw new Error('pty_ownership_transfer_output_credit_window_invalid')
    }
    if (
      !Number.isSafeInteger(windowFrames) ||
      windowFrames <= 0 ||
      windowFrames > PTY_OWNERSHIP_TRANSFER_OUTPUT_CREDIT_MAX_WINDOW_FRAMES
    ) {
      throw new Error('pty_ownership_transfer_output_credit_frame_window_invalid')
    }
    this.windowBytes = windowBytes
    this.windowFrames = windowFrames
  }

  classify(frame: PtyOwnershipTransferOutputFrame): 'new' | 'duplicate' | 'conflict' {
    validateFrame(frame)
    if (frame.seq <= this.acknowledgedThroughSeq) {
      return 'duplicate'
    }
    const duplicate = this.sent.find((candidate) => candidate.seq === frame.seq)
    if (!duplicate) {
      return 'new'
    }
    return duplicate.data === frame.data ? 'duplicate' : 'conflict'
  }

  admit(frame: PtyOwnershipTransferOutputFrame): 'accepted' | 'duplicate' | 'capacity' {
    const bytes = validateFrame(frame)
    if (frame.seq <= this.acknowledgedThroughSeq) {
      return 'duplicate'
    }
    const duplicate = this.sent.find((candidate) => candidate.seq === frame.seq)
    if (duplicate) {
      if (duplicate.data !== frame.data) {
        throw new Error('pty_ownership_transfer_output_credit_frame_conflict')
      }
      return 'duplicate'
    }
    const previousSeq = this.sent.at(-1)?.seq ?? this.acknowledgedThroughSeq
    if (previousSeq > 0 && frame.seq !== previousSeq + 1) {
      throw new Error('pty_ownership_transfer_output_credit_sequence_gap')
    }
    if (this.sent.length >= this.windowFrames || this.inFlightBytes + bytes > this.windowBytes) {
      return 'capacity'
    }
    this.sent.push(Object.freeze({ seq: frame.seq, data: frame.data, bytes }))
    this.inFlightBytes += bytes
    return 'accepted'
  }

  acknowledge(throughSeq: number): PtyOwnershipTransferOutputCreditAcknowledgement {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < this.acknowledgedThroughSeq) {
      throw new Error('pty_ownership_transfer_output_credit_ack_invalid')
    }
    if (throughSeq === this.acknowledgedThroughSeq) {
      return Object.freeze({ throughSeq, acknowledgedBytes: 0, inFlightBytes: this.inFlightBytes })
    }
    const highestSent = this.sent.at(-1)?.seq
    if (highestSent === undefined || throughSeq > highestSent) {
      throw new Error('pty_ownership_transfer_output_credit_ack_ahead')
    }
    let acknowledgedBytes = 0
    let count = 0
    for (const frame of this.sent) {
      if (frame.seq > throughSeq) {
        break
      }
      acknowledgedBytes += frame.bytes
      count += 1
    }
    if (count === 0) {
      throw new Error('pty_ownership_transfer_output_credit_ack_invalid')
    }
    this.sent.splice(0, count)
    this.acknowledgedThroughSeq = throughSeq
    this.inFlightBytes -= acknowledgedBytes
    return Object.freeze({ throughSeq, acknowledgedBytes, inFlightBytes: this.inFlightBytes })
  }

  snapshot(): Readonly<{ throughSeq: number; inFlightBytes: number; sentFrames: number }> {
    return Object.freeze({
      throughSeq: this.acknowledgedThroughSeq,
      inFlightBytes: this.inFlightBytes,
      sentFrames: this.sent.length
    })
  }
}

function validateFrame(frame: PtyOwnershipTransferOutputFrame): number {
  if (
    !Number.isSafeInteger(frame.seq) ||
    frame.seq <= 0 ||
    typeof frame.data !== 'string' ||
    frame.data.length === 0 ||
    frame.truncated === true
  ) {
    throw new Error('pty_ownership_transfer_output_credit_frame_invalid')
  }
  return Buffer.byteLength(frame.data, 'utf8')
}
