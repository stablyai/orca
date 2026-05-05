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

  // Why: ripgrep currently returns positive submatch lengths, but this reveal
  // helper is shared by mount-time and already-mounted navigation. Falling back
  // to a one-column range keeps reveal robust if stale or malformed payloads
  // ever reach the editor.
  const safeLength = Math.max(1, matchLength)
  const safeEndColumn = Math.min(safeStartColumn + safeLength, Math.max(2, lineMaxColumn))

  return {
    startLineNumber: safeLine,
    startColumn: safeStartColumn,
    endLineNumber: safeLine,
    endColumn: Math.max(safeStartColumn + 1, safeEndColumn)
  }
}
