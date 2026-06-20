export type EagerBufferChunk = {
  data: string
  bytes: number
}

export function clampUtf8Tail(data: string, maxBytes: number): EagerBufferChunk {
  if (!data || maxBytes <= 0) {
    return { data: '', bytes: 0 }
  }

  let start = data.length
  let bytes = 0
  while (start > 0) {
    const previous = getPreviousUtf8CodePoint(data, start)
    if (bytes > 0 && bytes + previous.bytes > maxBytes) {
      break
    }
    bytes += previous.bytes
    start = previous.start
    if (bytes >= maxBytes) {
      break
    }
  }
  return { data: data.slice(start), bytes }
}

function getPreviousUtf8CodePoint(
  data: string,
  endIndex: number
): { start: number; bytes: number } {
  let start = endIndex - 1
  const codeUnit = data.charCodeAt(start)
  const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff
  if (isLowSurrogate && start > 0) {
    const previous = data.charCodeAt(start - 1)
    if (previous >= 0xd800 && previous <= 0xdbff) {
      start -= 1
    }
  }
  const codePoint = data.codePointAt(start) ?? codeUnit
  if (codePoint <= 0x7f) {
    return { start, bytes: 1 }
  }
  if (codePoint <= 0x7ff) {
    return { start, bytes: 2 }
  }
  if (codePoint <= 0xffff) {
    return { start, bytes: 3 }
  }
  return { start, bytes: 4 }
}
