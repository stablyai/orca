import { rangeForParsedFileLink, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'
import type { TerminalLinkBufferRange } from './terminal-link-buffer'

export function rangeForParsedLinkOnRow(
  logicalLine: WrappedLogicalLine,
  startIndex: number,
  endIndex: number,
  bufferLineNumber: number
): TerminalLinkBufferRange | null {
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
