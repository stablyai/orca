import { buildEdgeWrappedHttpLogicalLineCandidates } from './edge-wrapped-terminal-http-links'
import { buildHardWrappedHttpLogicalLineCandidates } from './hard-wrapped-terminal-http-links'
import { dedupeLogicalLines } from './terminal-link-logical-line-deduplication'
import { buildWrappedLogicalLine, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'
import type { TerminalLinkBuffer } from './terminal-link-buffer'

export function hasHardWrappedRows(logicalLine: WrappedLogicalLine): boolean {
  return logicalLine.rows.slice(1).some((row) => !row.isWrapped)
}

export function buildTerminalHttpLogicalLines(
  buffer: TerminalLinkBuffer,
  bufferLineNumber: number
) {
  const nativeWrappedLogicalLine = buildWrappedLogicalLine(buffer, bufferLineNumber)
  return dedupeLogicalLines([
    ...(nativeWrappedLogicalLine && nativeWrappedLogicalLine.rows.length > 1
      ? [nativeWrappedLogicalLine]
      : []),
    ...buildHardWrappedHttpLogicalLineCandidates(buffer, bufferLineNumber),
    ...buildEdgeWrappedHttpLogicalLineCandidates(buffer, bufferLineNumber),
    ...(nativeWrappedLogicalLine && nativeWrappedLogicalLine.rows.length === 1
      ? [nativeWrappedLogicalLine]
      : [])
  ]).sort((left, right) => Number(hasHardWrappedRows(right)) - Number(hasHardWrappedRows(left)))
}
