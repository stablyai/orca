export type JavaScriptNonCodeRange = { start: number; end: number }

export function findJavaScriptNonCodeRanges(content: string): JavaScriptNonCodeRange[] {
  const ranges: JavaScriptNonCodeRange[] = []

  function scanComment(start: number): number {
    let index = start + 2
    if (content[start + 1] === '/') {
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
    return index
  }

  function scanQuotedString(start: number): number {
    const quote = content[start]
    let index = start + 1
    while (index < content.length) {
      if (content[index] === '\\') {
        index += 2
        continue
      }
      if (content[index] === quote) {
        index += 1
        break
      }
      if (content[index] === '\n') {
        break
      }
      index += 1
    }
    ranges.push({ start, end: index })
    return index
  }

  function scanTemplate(start: number): number {
    let segmentStart = start
    let index = start + 1
    while (index < content.length) {
      if (content[index] === '\\') {
        index += 2
        continue
      }
      if (content[index] === '`') {
        index += 1
        ranges.push({ start: segmentStart, end: index })
        return index
      }
      if (content[index] === '$' && content[index + 1] === '{') {
        ranges.push({ start: segmentStart, end: index + 2 })
        const expressionEnd = scanCode(index + 2, true)
        if (expressionEnd >= content.length) {
          return expressionEnd
        }
        // Rewind so the closing `}` remains classified as non-code.
        segmentStart = expressionEnd - 1
        index = expressionEnd
        continue
      }
      index += 1
    }
    ranges.push({ start: segmentStart, end: index })
    return index
  }

  function scanCode(start: number, stopAtTemplateBrace: boolean): number {
    let braceDepth = 0
    let index = start
    while (index < content.length) {
      const char = content[index]
      const next = content[index + 1]
      if (char === '/' && (next === '/' || next === '*')) {
        index = scanComment(index)
        continue
      }
      if (char === "'" || char === '"') {
        index = scanQuotedString(index)
        continue
      }
      if (char === '`') {
        index = scanTemplate(index)
        continue
      }
      if (stopAtTemplateBrace) {
        if (char === '{') {
          braceDepth += 1
        } else if (char === '}') {
          if (braceDepth === 0) {
            return index + 1
          }
          braceDepth -= 1
        }
      }
      index += 1
    }
    return index
  }

  scanCode(0, false)
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
