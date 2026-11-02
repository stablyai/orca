export type MonacoRevealRange = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export function computeMonacoRevealRange(params: {
  line: number
  column: number
  matchLength: number
  maxLine: number
  lineMaxColumn: number
}): MonacoRevealRange {
  const { line, column, matchLength, maxLine, lineMaxColumn } = params
  const safeLine = Math.min(Math.max(1, line), Math.max(1, maxLine))
  const safeStartColumn = Math.min(Math.max(1, column), Math.max(1, lineMaxColumn))

  // Stale or malformed lengths still need a valid one-column reveal range.
  const safeLength = Math.max(1, matchLength)
  const safeEndColumn = Math.min(safeStartColumn + safeLength, Math.max(2, lineMaxColumn))

  return {
    startLineNumber: safeLine,
    startColumn: safeStartColumn,
    endLineNumber: safeLine,
    endColumn: Math.max(safeStartColumn + 1, safeEndColumn)
  }
}
