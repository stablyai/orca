/** Converts ordered ripgrep byte offsets without rescanning each match's prefix. */
export function createRipgrepOffsetReader(text: string): (byteOffset: number) => number | null {
  let bytePosition = 0
  let column = 0
  return (byteOffset) => {
    if (!Number.isSafeInteger(byteOffset) || byteOffset < bytePosition) {
      return null
    }
    while (bytePosition < byteOffset && column < text.length) {
      const point = text.codePointAt(column)!
      bytePosition += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
      column += point > 0xffff ? 2 : 1
    }
    return bytePosition === byteOffset ? column : null
  }
}

export function* ripgrepMatchRanges(
  text: string,
  submatches: readonly { start: number; end: number }[],
  readOffset = createRipgrepOffsetReader(text),
  onInvalidRange?: () => void
): Generator<{ start: number; end: number }> {
  if (submatches.length === 0) {
    yield { start: 0, end: text.length > 0 ? (text.codePointAt(0)! > 0xffff ? 2 : 1) : 0 }
    return
  }
  for (const submatch of submatches) {
    const start = readOffset(submatch.start)
    const end = readOffset(submatch.end)
    if (start !== null && end !== null) {
      yield { start, end }
    } else {
      onInvalidRange?.()
    }
  }
}
