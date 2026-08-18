export type Utf8ByteLengthMeasurement = {
  byteLength: number
  exceededLimit: boolean
}

export type Utf8TextTail = {
  text: string
  bytes: number
}

/**
 * Bounds-safe replacement for `String.prototype.codePointAt`.
 *
 * Why: once V8 optimizes the calling function, `codePointAt` on a sliced string pairs a
 * trailing high surrogate with the code unit that follows the SLICE inside its parent, so a
 * prefix slice cut mid-pair reports a code point the string does not contain (and one byte
 * too many). `charCodeAt` stays bounds-correct in every tier, so pair the units explicitly.
 */
export function readUtf8CodePointAt(text: string, index: number): number {
  const leadUnit = text.charCodeAt(index)
  if (leadUnit < 0xd800 || leadUnit > 0xdbff || index + 1 >= text.length) {
    return leadUnit
  }
  const trailUnit = text.charCodeAt(index + 1)
  if (trailUnit < 0xdc00 || trailUnit > 0xdfff) {
    return leadUnit
  }
  return (leadUnit - 0xd800) * 0x400 + (trailUnit - 0xdc00) + 0x10000
}

export function measureUtf8ByteLength(
  text: string,
  options: { stopAfterBytes?: number } = {}
): Utf8ByteLengthMeasurement {
  const stopAfterBytes = options.stopAfterBytes
  let byteLength = 0
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = readUtf8CodePointAt(text, index)
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

export function isUtf8ByteLengthWithinLimit(text: string, maxBytes: number): boolean {
  if (text.length === 0) {
    return true
  }
  if (text.length > maxBytes) {
    return false
  }
  return !measureUtf8ByteLength(text, { stopAfterBytes: maxBytes }).exceededLimit
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

export function clampUtf8TextPrefix(text: string, maxBytes: number): string {
  if (!text || maxBytes <= 0) {
    return ''
  }
  let bytes = 0
  let end = 0
  while (end < text.length) {
    const codePoint = readUtf8CodePointAt(text, end)
    const codePointBytes = getUtf8ByteLengthForCodePoint(codePoint)
    if (bytes + codePointBytes > maxBytes) {
      break
    }
    bytes += codePointBytes
    end += codePoint > 0xffff ? 2 : 1
  }
  return end === text.length ? text : text.slice(0, end)
}

export function getUtf8ChunkEndIndex(text: string, startIndex: number, maxBytes: number): number {
  let bytes = 0
  let endIndex = startIndex
  while (endIndex < text.length) {
    const codePoint = readUtf8CodePointAt(text, endIndex)
    const codePointBytes = getUtf8ByteLengthForCodePoint(codePoint)
    if (bytes > 0 && bytes + codePointBytes > maxBytes) {
      break
    }
    bytes += codePointBytes
    endIndex += codePoint > 0xffff ? 2 : 1
  }
  return endIndex
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
    bytes: getUtf8ByteLengthForCodePoint(readUtf8CodePointAt(text, start))
  }
}
