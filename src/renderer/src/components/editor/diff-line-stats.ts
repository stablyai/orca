/**
 * Compute approximate added/removed line counts by matching lines between
 * original and modified content using a multiset approach.
 */
export function computeLineStats(
  original: string,
  modified: string,
  status: string
): { added: number; removed: number } | null {
  // Why: for very large files, splitting in React render would block the UI.
  if (original.length + modified.length > 500_000) {
    return null
  }
  if (status === 'added') {
    return { added: modified ? countLinesWithoutAllocation(modified) : 0, removed: 0 }
  }
  if (status === 'deleted') {
    return { added: 0, removed: original ? countLinesWithoutAllocation(original) : 0 }
  }

  const origMap = new Map<string, number>()
  const originalLineCount = countDiffLinesIntoMultiset(original, origMap)
  let modifiedLineCount = 0
  let matched = 0

  forEachDiffLine(modified, (line) => {
    modifiedLineCount += 1
    const count = origMap.get(line) ?? 0
    if (count > 0) {
      origMap.set(line, count - 1)
      matched += 1
    }
  })

  return {
    added: modifiedLineCount - matched,
    removed: originalLineCount - matched
  }
}

function countDiffLinesIntoMultiset(content: string, lineCounts: Map<string, number>): number {
  let lineCount = 0
  forEachDiffLine(content, (line) => {
    lineCount += 1
    lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1)
  })
  return lineCount
}

function countLinesWithoutAllocation(content: string): number {
  let lineCount = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineCount += 1
    }
  }
  return lineCount
}

function forEachDiffLine(content: string, visit: (line: string) => void): void {
  let lineStart = 0
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue
    }
    visit(content.slice(lineStart, index))
    lineStart = index + 1
  }
}
