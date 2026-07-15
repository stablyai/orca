import type { IBufferRange } from '@xterm/xterm'
import type { WrappedLogicalLine } from './wrapped-terminal-link-ranges'

// Why: the path-fragment reconstruction joins rows without xterm wrap metadata,
// which can glue an unrelated next logical line onto a URL (#8832). A genuine
// hard wrap only happens at the row's right edge, so a link may cross a
// reconstructed row boundary only when the earlier row's content reaches its
// final column (one-cell tolerance for wide-glyph wraps).
export function linkCrossesImplausibleWrapBoundary(
  logicalLine: WrappedLogicalLine,
  startIndex: number,
  endIndex: number
): boolean {
  for (let rowIndex = 0; rowIndex < logicalLine.rows.length - 1; rowIndex++) {
    const row = logicalLine.rows[rowIndex]
    const rowEnd = row.startIndex + row.text.length
    if (startIndex >= rowEnd || endIndex <= rowEnd || logicalLine.rows[rowIndex + 1].isWrapped) {
      continue
    }
    const columnAfterRowText = row.columns.at(-1)
    if (columnAfterRowText === undefined || columnAfterRowText < row.lineLength - 1) {
      return true
    }
  }
  return false
}

export function rangeContainsBufferPosition(
  range: IBufferRange,
  position: { x: number; y: number },
  terminalColumns: number
): boolean {
  const lower = range.start.y * terminalColumns + range.start.x
  const upper = range.end.y * terminalColumns + range.end.x
  const current = position.y * terminalColumns + position.x
  return lower <= current && current <= upper
}
