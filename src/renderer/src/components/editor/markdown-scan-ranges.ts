// Fence ranges depend only on the scanned string, so callers scanning one body
// repeatedly compute them once and share them across sibling matches.
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
      // Why: built once per fence; a per-line rebuild recompiles the same regex for every fenced line.
      if (openFence.closingPattern.test(lineText)) {
        ranges.push([openFence.start, offset + line.length])
        openFence = null
      }
    } else {
      const openingFenceMatch = lineText.match(/^ {0,3}(`{3,}|~{3,})/u)
      if (openingFenceMatch?.[1]) {
        openFence = {
          closingPattern: new RegExp(
            `^ {0,3}${openingFenceMatch[1][0]}{${openingFenceMatch[1].length},}\\s*$`
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

export function isInsideRange(index: number, ranges: MarkdownFenceRanges): boolean {
  return ranges.some(([start, end]) => index >= start && index < end)
}

// CommonMark code spans: a backtick run only closes on a run of the same
// length, so `` `<details>` `` is one span even though `<details>` alone
// isn't. Mirrors the tick-matching in raw-markdown-html.ts's inline scan.
export function markdownCodeSpanRanges(content: string): MarkdownFenceRanges {
  const ranges: [number, number][] = []
  let index = 0

  while (index < content.length) {
    if (content[index] !== '`') {
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
