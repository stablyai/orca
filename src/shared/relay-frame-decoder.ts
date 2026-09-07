import {
  containFrameDecoderContinuation,
  publishFrameDecoderError,
  type DecodedFrame,
  type FrameDecoderOptions
} from './relay-frame-decoder-contract'
import { RelayFrameBuffer } from './relay-frame-buffer'
export {
  FrameDecoderContinuationError,
  type DecodedFrame,
  type FrameDecoderOptions
} from './relay-frame-decoder-contract'

export const HEADER_LENGTH = 13
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024
export const FRAME_DECODER_MAX_FRAMES_PER_TURN = 64
export const FRAME_DECODER_MAX_BYTES_PER_TURN = MAX_MESSAGE_SIZE + HEADER_LENGTH
export const FRAME_DECODER_MAX_TURN_MS = 4,
  FRAME_DECODER_MAX_RETAINED_BYTES = MAX_MESSAGE_SIZE + HEADER_LENGTH + 1024 * 1024

export class FrameDecoder {
  private readonly buffer = new RelayFrameBuffer()
  private oversizedPayloadBytesRemaining = 0
  private onFrame: (frame: DecodedFrame) => void
  private onError: ((err: Error) => void) | null
  private maxFramesPerTurn: number
  private maxBytesPerTurn: number
  private maxTurnMs: number
  private now: () => number
  private schedule: (callback: () => void) => unknown
  private cancelScheduled: (handle: unknown) => void
  private pause: (() => void) | null
  private resume: (() => void) | null
  private continuationHandle: unknown
  private continuationHandleAssigned = false
  private continuationScheduled = false
  private paused = false
  private draining = false
  private generation = 0

  constructor(
    onFrame: (frame: DecodedFrame) => void,
    onError?: (err: Error) => void,
    options: FrameDecoderOptions = {}
  ) {
    this.onFrame = onFrame
    this.onError = onError ?? null
    this.maxFramesPerTurn = positiveLimit(
      options.maxFramesPerTurn,
      FRAME_DECODER_MAX_FRAMES_PER_TURN
    )
    this.maxBytesPerTurn = positiveLimit(options.maxBytesPerTurn, FRAME_DECODER_MAX_BYTES_PER_TURN)
    this.maxTurnMs = positiveLimit(options.maxTurnMs, FRAME_DECODER_MAX_TURN_MS)
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((callback) => setImmediate(callback))
    this.cancelScheduled =
      options.cancelScheduled ?? ((handle) => clearImmediate(handle as NodeJS.Immediate))
    this.pause = options.pause ?? null
    this.resume = options.resume ?? null
  }

  feed(chunk: Buffer | Uint8Array): void {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const retained = this.buffer.length + buf.length
    if (retained > FRAME_DECODER_MAX_RETAINED_BYTES) {
      this.reset()
      publishFrameDecoderError(
        this.onError,
        new Error(`Frame decoder retained-input limit exceeded: ${retained}`)
      )
      return
    }
    if (buf.length > 0) {
      this.buffer.append(buf)
    }
    if (!this.draining && !this.continuationScheduled) {
      this.drainTurn()
    }
  }

  reset(): void {
    this.generation += 1
    this.cancelContinuation()
    this.buffer.clear()
    this.oversizedPayloadBytesRemaining = 0
    this.releasePause()
  }

  drain(): Buffer {
    const out = this.buffer.drain()
    this.reset()
    return out
  }

  private drainTurn(): void {
    if (this.draining) {
      return
    }
    this.draining = true
    const generation = this.generation
    const startedAt = this.now()
    let frames = 0
    let bytes = 0

    try {
      while (generation === this.generation) {
        if (
          frames >= this.maxFramesPerTurn ||
          bytes >= this.maxBytesPerTurn ||
          (frames > 0 && this.now() - startedAt >= this.maxTurnMs)
        ) {
          break
        }
        const discarded = this.discardOversizedPayload(bytes)
        if (discarded > 0) {
          bytes += discarded
          continue
        }
        if (this.buffer.length < HEADER_LENGTH) {
          break
        }
        const header = this.buffer.peek(HEADER_LENGTH)
        const length = header.readUInt32BE(9)
        if (length > MAX_MESSAGE_SIZE) {
          this.buffer.discard(HEADER_LENGTH)
          this.oversizedPayloadBytesRemaining = length
          bytes += HEADER_LENGTH
          publishFrameDecoderError(
            this.onError,
            new Error(`Frame payload too large: ${length} bytes — discarded`)
          )
          continue
        }
        const totalLength = HEADER_LENGTH + length
        if (this.buffer.length < totalLength) {
          break
        }
        if (frames > 0 && bytes + totalLength > this.maxBytesPerTurn) {
          break
        }
        const framed = this.buffer.take(totalLength)
        frames += 1
        bytes += totalLength
        this.onFrame({
          type: framed[0],
          id: framed.readUInt32BE(1),
          ack: framed.readUInt32BE(5),
          payload: framed.subarray(HEADER_LENGTH, totalLength)
        })
      }
    } finally {
      this.draining = false
    }

    if (generation !== this.generation) {
      return
    }
    if (this.hasRunnableWork()) {
      this.scheduleContinuation()
    } else {
      this.releasePause()
    }
  }

  private discardOversizedPayload(bytes: number): number {
    if (this.oversizedPayloadBytesRemaining === 0 || this.buffer.length === 0) {
      return 0
    }
    const discarded = Math.min(
      this.oversizedPayloadBytesRemaining,
      this.buffer.length,
      Math.max(1, this.maxBytesPerTurn - bytes)
    )
    this.buffer.discard(discarded)
    this.oversizedPayloadBytesRemaining -= discarded
    return discarded
  }

  private hasRunnableWork(): boolean {
    if (this.oversizedPayloadBytesRemaining > 0) {
      return this.buffer.length > 0
    }
    if (this.buffer.length < HEADER_LENGTH) {
      return false
    }
    const length = this.buffer.peek(HEADER_LENGTH).readUInt32BE(9)
    return length > MAX_MESSAGE_SIZE || this.buffer.length >= HEADER_LENGTH + length
  }

  private scheduleContinuation(): void {
    if (this.continuationScheduled) {
      return
    }
    const generation = this.generation
    this.continuationScheduled = true
    try {
      this.acquirePause()
    } catch (error) {
      this.continuationScheduled = false
      throw error
    }
    if (generation !== this.generation) {
      this.continuationScheduled = false
      return
    }
    try {
      this.continuationHandle = this.schedule(() => {
        if (!this.continuationScheduled || generation !== this.generation) {
          return
        }
        this.continuationScheduled = false
        this.continuationHandleAssigned = false
        this.continuationHandle = undefined
        try {
          this.drainTurn()
        } catch (error) {
          containFrameDecoderContinuation(() => this.reset(), this.onError, error)
        }
      })
      this.continuationHandleAssigned = true
    } catch (error) {
      this.continuationScheduled = false
      this.continuationHandle = undefined
      this.releasePause()
      throw error
    }
  }

  private cancelContinuation(): void {
    if (!this.continuationScheduled) {
      return
    }
    this.continuationScheduled = false
    if (this.continuationHandleAssigned) {
      this.cancelScheduled(this.continuationHandle)
    }
    this.continuationHandleAssigned = false
    this.continuationHandle = undefined
  }

  private acquirePause(): void {
    if (!this.paused) {
      this.paused = true
      try {
        this.pause?.()
      } catch (error) {
        this.paused = false
        throw error
      }
    }
  }

  private releasePause(): void {
    if (this.paused) {
      this.paused = false
      this.resume?.()
    }
  }
}

const positiveLimit = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
