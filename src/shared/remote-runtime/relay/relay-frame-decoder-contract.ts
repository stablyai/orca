export type DecodedFrame = {
  type: number
  id: number
  ack: number
  payload: Buffer
}

export class FrameDecoderContinuationError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Frame decoder continuation failed: ${detail}`)
    this.name = 'FrameDecoderContinuationError'
    this.cause = cause
  }
}

export function publishFrameDecoderError(
  observer: ((error: Error) => void) | null,
  error: Error
): void {
  try {
    observer?.(error)
  } catch {
    // Error observers cannot escape decoder ownership.
  }
}

export function containFrameDecoderContinuation(
  reset: () => void,
  observer: ((error: Error) => void) | null,
  cause: unknown
): void {
  try {
    reset()
  } catch {
    // Reset clears retained state before releasing paused read ownership.
  }
  publishFrameDecoderError(observer, new FrameDecoderContinuationError(cause))
}

export type FrameDecoderOptions = {
  maxFramesPerTurn?: number
  maxBytesPerTurn?: number
  maxTurnMs?: number
  now?: () => number
  schedule?: (callback: () => void) => unknown
  cancelScheduled?: (handle: unknown) => void
  pause?: () => void
  resume?: () => void
}
