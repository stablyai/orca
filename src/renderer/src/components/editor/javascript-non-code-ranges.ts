export type JavaScriptNonCodeRange = { start: number; end: number }

export function findJavaScriptNonCodeRanges(content: string): JavaScriptNonCodeRange[] {
  const ranges: JavaScriptNonCodeRange[] = []
  for (let index = 0; index < content.length; index += 1) {
    const start = index
    const char = content[index]
    const next = content[index + 1]
    if (char === '/' && (next === '/' || next === '*')) {
      index += 2
      if (next === '/') {
        while (index < content.length && content[index] !== '\n') {
          index += 1
        }
      } else {
        while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
          index += 1
        }
        index = Math.min(index + 2, content.length)
      }
      ranges.push({ start, end: index })
      index -= 1
      continue
    }
    if (char !== "'" && char !== '"' && char !== '`') {
      continue
    }
    index += 1
    while (index < content.length) {
      if (content[index] === '\\') {
        index += 2
        continue
      }
      if (content[index] === char) {
        index += 1
        break
      }
      if (char !== '`' && content[index] === '\n') {
        break
      }
      index += 1
    }
    ranges.push({ start, end: index })
    index -= 1
  }
  return ranges
}

export function isOffsetInJavaScriptNonCodeRange(
  offset: number,
  ranges: JavaScriptNonCodeRange[]
): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const range = ranges[mid]
    if (offset < range.start) {
      high = mid - 1
    } else if (offset >= range.end) {
      low = mid + 1
    } else {
      return true
    }
  }
  return false
}
