import {
  buildServeSimKeyboardFramesForKey,
  type ServeSimKeyboardFrame
} from '../../../../shared/emulator-keyboard-frame'
import { measureClipboardTextByteLength } from '../../../../shared/clipboard-text'

export const EMULATOR_KEYBOARD_PASTE_MAX_BYTES = 4 * 1024
export const EMULATOR_KEYBOARD_PASTE_MAX_FRAMES_PER_CHUNK = 48
export const EMULATOR_KEYBOARD_PASTE_FRAME_DELAY_MS = 4

export type EmulatorKeyboardPasteResult =
  | {
      byteLength: number
      chunkCount: number
      status: 'sent'
    }
  | {
      byteLength: number
      reason: 'empty' | 'too-large' | 'unsupported-text' | 'target-unavailable'
      status: 'rejected'
    }
  | {
      byteLength: number
      reason: 'cancelled'
      status: 'cancelled'
    }

type EmulatorKeyboardPastePlan =
  | {
      byteLength: number
      chunks: ServeSimKeyboardFrame[][]
      status: 'accepted'
    }
  | {
      byteLength: number
      reason: 'empty' | 'too-large' | 'unsupported-text'
      status: 'rejected'
    }

type EmulatorKeyboardPasteValidation =
  | {
      byteLength: number
      status: 'accepted'
    }
  | {
      byteLength: number
      reason: 'empty' | 'too-large' | 'unsupported-text'
      status: 'rejected'
    }

export type PasteTextIntoEmulatorKeyboardOptions = {
  frameDelayMs?: number
  isCancelled?: () => boolean
  maxBytes?: number
  maxFramesPerChunk?: number
  sendKeyboardFrames: (frames: ServeSimKeyboardFrame[]) => boolean
  text: string
}

export function getEmulatorKeyboardPasteByteLength(text: string): number {
  return measureClipboardTextByteLength(text).byteLength
}

export function buildEmulatorKeyboardPastePlan(
  text: string,
  options: {
    maxBytes?: number
    maxFramesPerChunk?: number
  } = {}
): EmulatorKeyboardPastePlan {
  const validation = validateEmulatorKeyboardPasteText(text, options.maxBytes)
  if (validation.status === 'rejected') {
    return validation
  }
  const chunks = [...iterateEmulatorKeyboardPasteChunks(text, options.maxFramesPerChunk)]
  return { byteLength: validation.byteLength, chunks, status: 'accepted' }
}

function validateEmulatorKeyboardPasteText(
  text: string,
  maxBytes?: number
): EmulatorKeyboardPasteValidation {
  const byteLimit = getPositiveIntegerLimit(maxBytes, EMULATOR_KEYBOARD_PASTE_MAX_BYTES)
  const byteLengthMeasurement = measureClipboardTextByteLength(text, { stopAfterBytes: byteLimit })
  if (byteLengthMeasurement.exceededLimit) {
    return { byteLength: byteLengthMeasurement.byteLength, reason: 'too-large', status: 'rejected' }
  }
  const { byteLength } = byteLengthMeasurement
  let hasFrames = false

  for (const char of text) {
    if (char === '\r') {
      continue
    }

    const charFrames = buildServeSimKeyboardFramesForKey(char)
    if (!charFrames) {
      return { byteLength, reason: 'unsupported-text', status: 'rejected' }
    }
    if (charFrames.length > 0) {
      hasFrames = true
    }
  }

  return hasFrames
    ? { byteLength, status: 'accepted' }
    : { byteLength, reason: 'empty', status: 'rejected' }
}

export function* iterateEmulatorKeyboardPasteChunks(
  text: string,
  maxFramesPerChunk = EMULATOR_KEYBOARD_PASTE_MAX_FRAMES_PER_CHUNK
): Generator<ServeSimKeyboardFrame[]> {
  const normalizedMaxFramesPerChunk = getPositiveIntegerLimit(
    maxFramesPerChunk,
    EMULATOR_KEYBOARD_PASTE_MAX_FRAMES_PER_CHUNK
  )
  let currentChunk: ServeSimKeyboardFrame[] = []

  for (const char of text) {
    if (char === '\r') {
      continue
    }

    const charFrames = buildServeSimKeyboardFramesForKey(char)
    if (!charFrames) {
      return
    }

    if (
      currentChunk.length > 0 &&
      currentChunk.length + charFrames.length > normalizedMaxFramesPerChunk
    ) {
      yield currentChunk
      currentChunk = []
    }
    currentChunk.push(...charFrames)
  }

  if (currentChunk.length > 0) {
    yield currentChunk
  }
}

export async function pasteTextIntoEmulatorKeyboard({
  frameDelayMs = EMULATOR_KEYBOARD_PASTE_FRAME_DELAY_MS,
  isCancelled,
  maxBytes,
  maxFramesPerChunk,
  sendKeyboardFrames,
  text
}: PasteTextIntoEmulatorKeyboardOptions): Promise<EmulatorKeyboardPasteResult> {
  const validation = validateEmulatorKeyboardPasteText(text, maxBytes)
  if (validation.status === 'rejected') {
    return validation
  }

  const chunks = iterateEmulatorKeyboardPasteChunks(text, maxFramesPerChunk)
  let chunk = chunks.next()
  let chunkCount = 0
  while (!chunk.done) {
    if (isCancelled?.()) {
      return { byteLength: validation.byteLength, reason: 'cancelled', status: 'cancelled' }
    }

    if (!sendKeyboardFrames(chunk.value)) {
      return {
        byteLength: validation.byteLength,
        reason: 'target-unavailable',
        status: 'rejected'
      }
    }
    chunkCount += 1

    const sentFrameCount = chunk.value.length
    chunk = chunks.next()
    if (!chunk.done) {
      await waitForEmulatorKeyboardChunk(sentFrameCount, frameDelayMs)
    }
  }

  return { byteLength: validation.byteLength, chunkCount, status: 'sent' }
}

function getPositiveIntegerLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? fallback) : fallback
}

function waitForEmulatorKeyboardChunk(frameCount: number, frameDelayMs: number): Promise<void> {
  // Why: serve-sim's sender spaces frames with timers, so later chunks must wait
  // for the previous chunk's scheduled HID events instead of overlapping them.
  const delayMs = Math.max(frameDelayMs, frameCount * frameDelayMs)
  return new Promise((resolve) => window.setTimeout(resolve, delayMs))
}
