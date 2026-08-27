import { yieldToEventLoop } from '../../../shared/event-loop-yield'
import {
  getUtf8ByteLengthForCodePoint,
  readUtf8CodePointAt
} from '../../../shared/utf8-byte-limits'

export type PastePayloadMetadata = {
  byteLength: number
  exceededLimit: boolean
  hasControlSequences: boolean
  lineEndingByteLength: number
  lineCount: number
}

export const PASTE_PAYLOAD_METADATA_YIELD_CODE_UNITS = 256 * 1024

export function measurePastePayloadMetadata(
  text: string,
  options: { stopAfterBytes?: number } = {}
): PastePayloadMetadata {
  if (!text) {
    return createEmptyPastePayloadMetadata()
  }

  const stopAfterBytes = options.stopAfterBytes
  let byteLength = 0
  let hasControlSequences = false
  let lineEndingByteLength = 0
  let lineCount = 1
  let previousWasCarriageReturn = false

  for (let index = 0; index < text.length; index += 1) {
    const codePoint = readUtf8CodePointAt(text, index)
    byteLength += getUtf8ByteLengthForCodePoint(codePoint)
    hasControlSequences ||= isPasteControlSequenceCodePoint(codePoint)
    if (codePoint === 0x0d) {
      lineCount += 1
      lineEndingByteLength += 1
      previousWasCarriageReturn = true
    } else {
      if (codePoint === 0x0a) {
        lineEndingByteLength += 1
        if (!previousWasCarriageReturn) {
          lineCount += 1
        }
      }
      previousWasCarriageReturn = false
    }
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return {
        byteLength,
        exceededLimit: true,
        hasControlSequences,
        lineEndingByteLength,
        lineCount
      }
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }

  return { byteLength, exceededLimit: false, hasControlSequences, lineEndingByteLength, lineCount }
}

export async function measurePastePayloadMetadataWithYield(
  text: string,
  options: {
    stopAfterBytes?: number
    yieldAfterCodeUnits?: number
    yieldToEventLoop?: () => Promise<void>
  } = {}
): Promise<PastePayloadMetadata> {
  if (!text) {
    return createEmptyPastePayloadMetadata()
  }

  const stopAfterBytes = options.stopAfterBytes
  const yieldAfterCodeUnits = Math.max(
    1,
    options.yieldAfterCodeUnits ?? PASTE_PAYLOAD_METADATA_YIELD_CODE_UNITS
  )
  const yieldBetweenBatches = options.yieldToEventLoop ?? yieldToEventLoop
  let nextYieldAt = yieldAfterCodeUnits
  let byteLength = 0
  let hasControlSequences = false
  let lineEndingByteLength = 0
  let lineCount = 1
  let previousWasCarriageReturn = false

  for (let index = 0; index < text.length; index += 1) {
    const codePoint = readUtf8CodePointAt(text, index)
    byteLength += getUtf8ByteLengthForCodePoint(codePoint)
    hasControlSequences ||= isPasteControlSequenceCodePoint(codePoint)
    if (codePoint === 0x0d) {
      lineCount += 1
      lineEndingByteLength += 1
      previousWasCarriageReturn = true
    } else {
      if (codePoint === 0x0a) {
        lineEndingByteLength += 1
        if (!previousWasCarriageReturn) {
          lineCount += 1
        }
      }
      previousWasCarriageReturn = false
    }
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return {
        byteLength,
        exceededLimit: true,
        hasControlSequences,
        lineEndingByteLength,
        lineCount
      }
    }
    if (codePoint > 0xffff) {
      index += 1
    }
    if (index >= nextYieldAt) {
      await yieldBetweenBatches()
      nextYieldAt = index + yieldAfterCodeUnits
    }
  }

  return { byteLength, exceededLimit: false, hasControlSequences, lineEndingByteLength, lineCount }
}

export function getPastePayloadUtf8ByteLength(text: string): number {
  return measurePastePayloadMetadata(text).byteLength
}

export function countPastePayloadLines(text: string): number {
  return measurePastePayloadMetadata(text).lineCount
}

export function hasPastePayloadControlSequence(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = readUtf8CodePointAt(text, index)
    if (isPasteControlSequenceCodePoint(codePoint)) {
      return true
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  return false
}

function createEmptyPastePayloadMetadata(): PastePayloadMetadata {
  return {
    byteLength: 0,
    exceededLimit: false,
    hasControlSequences: false,
    lineEndingByteLength: 0,
    lineCount: 0
  }
}

function isPasteControlSequenceCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x08 ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    codePoint === 0x7f
  )
}
