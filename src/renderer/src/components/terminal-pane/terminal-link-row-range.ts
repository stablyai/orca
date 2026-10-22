import type { IBufferRange } from '@xterm/xterm'
import { rangeForParsedFileLink, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'

export function rangeForParsedLinkOnRow(
  logicalLine: WrappedLogicalLine,
  startIndex: number,
  endIndex: number,
  bufferLineNumber: number
): IBufferRange | null {
  const row = logicalLine.rows.find((row) => row.y + 1 === bufferLineNumber)
  if (!row) {
    return null
  }
  const start = Math.max(startIndex, row.startIndex)
  const end = Math.min(endIndex, row.startIndex + row.text.length)
  if (start >= end) {
    return null
  }
  return rangeForParsedFileLink({ ...logicalLine, rows: [row] }, start, end)
}
