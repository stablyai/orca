// Share fence ranges across sibling scans of the same string to avoid rescanning.
export type MarkdownFenceRanges = readonly (readonly [number, number])[]

export function markdownFenceRanges(content: string): MarkdownFenceRanges {
  const ranges: [number, number][] = []
  let offset = 0
  let openFence: { closingPattern: RegExp; start: number } | null = null

  for (const lineMatch of content.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const line = lineMatch[0]
    if (line === '') {
      break
    }

    const lineText = line.replace(/(?:\r\n|\n|\r)$/u, '')
    if (openFence) {
      // Built once per fence: rebuilding it per line recompiled the same regex for every fenced line.
      if (openFence.closingPattern.test(lineText)) {
        ranges.push([openFence.start, offset + line.length])
        openFence = null
      }
    } else {
      const openingFenceMatch = lineText.match(/^ {0,3}(`{3,}|~{3,})/u)
      if (openingFenceMatch?.[1]) {
        if (
          openingFenceMatch[1][0] === '`' &&
          lineText.slice(openingFenceMatch[0].length).includes('`')
        ) {
          offset += line.length
          continue
        }
        openFence = {
          closingPattern: new RegExp(
            // CommonMark 4.5 permits only spaces/tabs after closing fences; generic whitespace also accepts invalid non-ASCII characters.
            `^ {0,3}${openingFenceMatch[1][0]}{${openingFenceMatch[1].length},}[ \\t]*$`
          ),
          start: offset
        }
      }
    }

    offset += line.length
  }

  if (openFence) {
    ranges.push([openFence.start, content.length])
  }

  return ranges
}

function rangeEndAt(index: number, ranges: MarkdownFenceRanges): number {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) {
      return end
    }
  }
  return -1
}

// Pair exact-length backtick runs outside fences; fenced content cannot open spans, while blank lines may remain inside spans.
export function markdownCodeSpanRanges(
  content: string,
  fenceRanges: MarkdownFenceRanges = markdownFenceRanges(content)
): MarkdownFenceRanges {
  const ranges: [number, number][] = []
  let index = 0

  while (index < content.length) {
    const fenceEnd = rangeEndAt(index, fenceRanges)
    if (fenceEnd !== -1) {
      index = fenceEnd
      continue
    }

    if (content[index] !== '`') {
      index += 1
      continue
    }

    let backslashes = 0
    for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) {
      backslashes += 1
    }
    if (backslashes % 2 === 1) {
      index += 1
      continue
    }

    let tickCount = 0
    while (content[index + tickCount] === '`') {
      tickCount += 1
    }

    const spanStart = index
    let searchFrom = index + tickCount
    let closingIndex = -1
    while (searchFrom < content.length) {
      const candidate = content.indexOf('`'.repeat(tickCount), searchFrom)
      if (candidate === -1) {
        break
      }
      if (rangeEndAt(candidate, fenceRanges) !== -1) {
        searchFrom = candidate + 1
        continue
      }
      if (
        (candidate === 0 || content[candidate - 1] !== '`') &&
        content[candidate + tickCount] !== '`'
      ) {
        closingIndex = candidate
        break
      }
      searchFrom = candidate + 1
    }

    if (closingIndex === -1) {
      index += tickCount
      continue
    }

    ranges.push([spanStart, closingIndex + tickCount])
    index = closingIndex + tickCount
  }

  return ranges
}
