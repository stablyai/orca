export type Utf8ByteLengthMeasurement = {
  byteLength: number
  exceededLimit: boolean
}

export type Utf8TextTail = {
  text: string
  bytes: number
}

export function measureUtf8ByteLength(
  text: string,
  options: { stopAfterBytes?: number } = {}
): Utf8ByteLengthMeasurement {
  const stopAfterBytes = options.stopAfterBytes
  let byteLength = 0
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) ?? 0
    byteLength += getUtf8ByteLengthForCodePoint(codePoint)
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return { byteLength, exceededLimit: true }
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  return { byteLength, exceededLimit: false }
}

export function getUtf8ByteLength(text: string): number {
  return measureUtf8ByteLength(text).byteLength
}

export function clampUtf8TextTail(text: string, maxBytes: number): Utf8TextTail {
  if (!text || maxBytes <= 0) {
    return { text: '', bytes: 0 }
  }

  let start = text.length
  let bytes = 0
  while (start > 0) {
    const previous = getPreviousUtf8CodePoint(text, start)
    if (previous.bytes > maxBytes || bytes + previous.bytes > maxBytes) {
      break
    }
    bytes += previous.bytes
    start = previous.start
    if (bytes >= maxBytes) {
      break
    }
  }
  return { text: text.slice(start), bytes }
}

export function getUtf8ByteLengthForCodePoint(codePoint: number): number {
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

function getPreviousUtf8CodePoint(
  text: string,
  endIndex: number
): { start: number; bytes: number } {
  let start = endIndex - 1
  const codeUnit = text.charCodeAt(start)
  const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff
  if (isLowSurrogate && start > 0) {
    const previous = text.charCodeAt(start - 1)
    if (previous >= 0xd800 && previous <= 0xdbff) {
      start -= 1
    }
  }
  return {
    start,
    bytes: getUtf8ByteLengthForCodePoint(text.codePointAt(start) ?? codeUnit)
  }
}
