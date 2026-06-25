export type PastePayloadMetadata = {
  byteLength: number
  exceededLimit: boolean
  hasControlSequences: boolean
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
  let lineCount = 1
  let previousWasCarriageReturn = false

  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) ?? 0
    byteLength += getUtf8ByteLengthForCodePoint(codePoint)
    hasControlSequences ||= isPasteControlSequenceCodePoint(codePoint)
    if (codePoint === 0x0d) {
      lineCount += 1
      previousWasCarriageReturn = true
    } else {
      if (codePoint === 0x0a && !previousWasCarriageReturn) {
        lineCount += 1
      }
      previousWasCarriageReturn = false
    }
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return { byteLength, exceededLimit: true, hasControlSequences, lineCount }
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }

  return { byteLength, exceededLimit: false, hasControlSequences, lineCount }
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
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultPastePayloadMetadataYield
  let nextYieldAt = yieldAfterCodeUnits
  let byteLength = 0
  let hasControlSequences = false
  let lineCount = 1
  let previousWasCarriageReturn = false

  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) ?? 0
    byteLength += getUtf8ByteLengthForCodePoint(codePoint)
    hasControlSequences ||= isPasteControlSequenceCodePoint(codePoint)
    if (codePoint === 0x0d) {
      lineCount += 1
      previousWasCarriageReturn = true
    } else {
      if (codePoint === 0x0a && !previousWasCarriageReturn) {
        lineCount += 1
      }
      previousWasCarriageReturn = false
    }
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return { byteLength, exceededLimit: true, hasControlSequences, lineCount }
    }
    if (codePoint > 0xffff) {
      index += 1
    }
    if (index >= nextYieldAt) {
      await yieldToEventLoop()
      nextYieldAt = index + yieldAfterCodeUnits
    }
  }

  return { byteLength, exceededLimit: false, hasControlSequences, lineCount }
}

export function getPastePayloadUtf8ByteLength(text: string): number {
  return measurePastePayloadMetadata(text).byteLength
}

export function countPastePayloadLines(text: string): number {
  return measurePastePayloadMetadata(text).lineCount
}

export function hasPastePayloadControlSequence(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) ?? 0
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

function getUtf8ByteLengthForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}

function defaultPastePayloadMetadataYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
