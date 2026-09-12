import {
  CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS,
  isClipboardTextByteLengthOverLimitWithYield,
  measureClipboardTextByteLength
} from './clipboard-text'
import { getUtf8ChunkEndIndex } from './utf8-byte-limits'

export const TERMINAL_INPUT_CHUNK_MAX_BYTES = 16 * 1024
export const TERMINAL_INPUT_MAX_BYTES = 16 * 1024 * 1024
export const TERMINAL_INPUT_TOO_LARGE_ERROR =
  'Terminal input is too large for a safe terminal send.'

export function getTerminalInputByteLength(text: string): number {
  return measureClipboardTextByteLength(text).byteLength
}

export function assertTerminalInputWithinLimit(
  text: string,
  maxBytes = TERMINAL_INPUT_MAX_BYTES
): string {
  if (isTerminalInputTooLarge(text, maxBytes)) {
    throw new Error(TERMINAL_INPUT_TOO_LARGE_ERROR)
  }
  return text
}

export function isTerminalInputTooLarge(
  text: string,
  maxBytes = TERMINAL_INPUT_MAX_BYTES
): boolean {
  return (
    text.length > maxBytes ||
    measureClipboardTextByteLength(text, { stopAfterBytes: maxBytes }).exceededLimit
  )
}

export function isTerminalInputTooLargeWithYield(
  text: string,
  maxBytes = TERMINAL_INPUT_MAX_BYTES
): Promise<boolean> {
  return isClipboardTextByteLengthOverLimitWithYield(text, maxBytes)
}

export function isTerminalInputTooLargeWithDeferredMeasurement(
  text: string,
  maxBytes = TERMINAL_INPUT_MAX_BYTES
): boolean | Promise<boolean> {
  if (text.length > maxBytes) {
    return true
  }
  if (text.length > CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS) {
    return isTerminalInputTooLargeWithYield(text, maxBytes)
  }
  return isTerminalInputTooLarge(text, maxBytes)
}

export function splitTerminalInputChunks(
  text: string,
  maxChunkBytes = TERMINAL_INPUT_CHUNK_MAX_BYTES
): string[] {
  return [...iterateTerminalInputChunks(text, maxChunkBytes)]
}

export function* iterateTerminalInputChunks(
  text: string,
  maxChunkBytes = TERMINAL_INPUT_CHUNK_MAX_BYTES
): Generator<string> {
  if (text.length === 0) {
    return
  }
  const normalizedMax = Number.isFinite(maxChunkBytes) && maxChunkBytes > 0 ? maxChunkBytes : 1
  const measurement = measureClipboardTextByteLength(text, { stopAfterBytes: normalizedMax })
  if (!measurement.exceededLimit) {
    yield text
    return
  }

  let startIndex = 0
  while (startIndex < text.length) {
    const endIndex = getUtf8ChunkEndIndex(text, startIndex, normalizedMax)
    yield text.slice(startIndex, endIndex)
    startIndex = endIndex
  }
}
