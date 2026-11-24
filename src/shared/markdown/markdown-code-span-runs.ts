export type MarkdownCodeSpanScanner = {
  /** Return the closing offset only for a run matching the opener’s exact length, as CommonMark requires. */
  findSpanEnd: (index: number) => number | null
}

export function createRawMarkdownCodeSpanScanner(content: string): MarkdownCodeSpanScanner {
  const starts: number[] = []
  const lengths: number[] = []
  const runsByLength = new Map<number, number[]>()
  for (const match of content.matchAll(/`+/g)) {
    const runLength = match[0].length
    const candidates = runsByLength.get(runLength)
    if (candidates) {
      candidates.push(starts.length)
    } else {
      runsByLength.set(runLength, [starts.length])
    }
    starts.push(match.index)
    lengths.push(runLength)
  }
  return createMarkdownBacktickRunLookup(starts, lengths, runsByLength)
}

export function createMarkdownBacktickRunLookup(
  starts: number[],
  lengths: number[],
  runsByLength: Map<number, number[]>,
  blocks?: number[],
  escaped?: boolean[]
): MarkdownCodeSpanScanner {
  function findRunAt(index: number): number {
    let low = 0
    let high = starts.length - 1
    let atOrBefore = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (starts[mid] <= index) {
        atOrBefore = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    if (atOrBefore === -1 || index >= starts[atOrBefore] + lengths[atOrBefore]) {
      return -1
    }
    return atOrBefore
  }

  function findFirstRunFrom(candidates: number[], offset: number): number {
    let low = 0
    let high = candidates.length - 1
    let match = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (starts[candidates[mid]] >= offset) {
        match = candidates[mid]
        high = mid - 1
      } else {
        low = mid + 1
      }
    }
    return match
  }

  return {
    findSpanEnd(index: number): number | null {
      const opener = findRunAt(index)
      if (opener === -1) {
        return null
      }
      // Resume within rejected runs; escaped backticks cannot open but marked permits them to close a span.
      const openStart = escaped?.[opener] ? Math.max(index, starts[opener] + 1) : index
      const openerEnd = starts[opener] + lengths[opener]
      if (openStart >= openerEnd) {
        return null
      }
      const candidates = runsByLength.get(openerEnd - openStart)
      if (!candidates) {
        return null
      }
      const closer = findFirstRunFrom(candidates, openerEnd)
      if (closer === -1 || (blocks && blocks[closer] !== blocks[opener])) {
        return null
      }
      return starts[closer] + lengths[closer]
    }
  }
}
