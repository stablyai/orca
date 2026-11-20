import { rangeForParsedFileLink, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'
import type { TerminalLinkBufferRange } from './terminal-link-buffer'

function rowFragmentCoversTrimmedSource(row: WrappedLogicalLine['rows'][number]): boolean {
  return row.text.trim() === row.sourceText.trim()
}

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

/** Whole-line wraps keep one multi-row range. A table cell only covers its own fragment. */
export function rangeForTerminalFileLinkOnBufferLine(
  logicalLine: WrappedLogicalLine,
  startIndex: number,
  endIndex: number,
  bufferLineNumber: number
): TerminalLinkBufferRange | null {
  const full = rangeForParsedFileLink(logicalLine, startIndex, endIndex)
  if (!full || bufferLineNumber < full.start.y || bufferLineNumber > full.end.y) {
    return null
  }
  if (logicalLine.rows.every(rowFragmentCoversTrimmedSource)) {
    return full
  }
  return rangeForParsedLinkOnRow(logicalLine, startIndex, endIndex, bufferLineNumber)
}
