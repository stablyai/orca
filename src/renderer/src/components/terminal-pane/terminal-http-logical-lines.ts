import type { IBufferLine } from '@xterm/xterm'
import { buildEdgeWrappedHttpLogicalLineCandidates } from './edge-wrapped-terminal-http-links'
import { buildHardWrappedHttpLogicalLineCandidates } from './hard-wrapped-terminal-http-links'
import { dedupeLogicalLines } from './terminal-link-logical-line-deduplication'
import { buildWrappedLogicalLine, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'

export function hasHardWrappedRows(logicalLine: WrappedLogicalLine): boolean {
  return logicalLine.rows.slice(1).some((row) => !row.isWrapped)
}

export function buildTerminalHttpLogicalLines(
  buffer: { getLine(y: number): IBufferLine | undefined },
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
