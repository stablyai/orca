import { buildTerminalHttpLogicalLines, hasHardWrappedRows } from './terminal-http-logical-lines'
import { extractTerminalHttpLinks } from './terminal-http-url-extraction'
import { dedupeLogicalLines } from './terminal-link-logical-line-deduplication'
import { rangeForParsedLinkOnRow } from './terminal-link-row-range'
import { extractTerminalFileLinkCandidates, type ParsedTerminalFileLink } from './terminal-links'
import { terminalLogicalLinkHasOscLink } from './terminal-osc-link-cells'
import {
  buildHardWrappedPathLogicalLineCandidates,
  buildWrappedLogicalLine,
  rangeForParsedFileLink,
  type WrappedLogicalLine
} from './wrapped-terminal-link-ranges'
import type { TerminalLinkBuffer, TerminalLinkBufferRange } from './terminal-link-buffer'

/** 1-based buffer cell, matching xterm link ranges. */
export type TerminalLinkBufferPosition = { x: number; y: number }

export type TerminalFileLinkAtBufferPosition = ParsedTerminalFileLink & {
  logicalLine: WrappedLogicalLine
}

export function findTerminalHttpLinkAtBufferPosition(
  buffer: TerminalLinkBuffer,
  position: TerminalLinkBufferPosition,
  terminalColumns: number
): string | null {
  for (const logicalLine of buildTerminalHttpLogicalLines(buffer, position.y)) {
    for (const parsed of extractTerminalHttpLinks(logicalLine.text)) {
      const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
      const rowRange = rangeForParsedLinkOnRow(
        logicalLine,
        parsed.startIndex,
        parsed.endIndex,
        position.y
      )
      if (
        !range ||
        (hasHardWrappedRows(logicalLine) && range.start.y === range.end.y) ||
        !rowRange ||
        !rangeContainsBufferPosition(rowRange, position, terminalColumns) ||
        terminalLogicalLinkHasOscLink(buffer, logicalLine, parsed.startIndex, parsed.endIndex)
      ) {
        continue
      }
      return parsed.url
    }
  }
  return null
}

export function buildCandidateLogicalLinesForBufferPosition(
  buffer: TerminalLinkBuffer,
  bufferLineNumber: number
): WrappedLogicalLine[] {
  const hardWrappedCandidates = buildHardWrappedPathLogicalLineCandidates(buffer, bufferLineNumber)
  const softWrappedLogicalLine = buildWrappedLogicalLine(buffer, bufferLineNumber)
  const candidates = softWrappedLogicalLine
    ? [...hardWrappedCandidates, softWrappedLogicalLine]
    : hardWrappedCandidates
  return dedupeLogicalLines(candidates)
}

/** Every file-link reading that covers the cell; callers choose among soft/hard-wrap guesses. */
export function findTerminalFileLinksAtBufferPosition(
  buffer: TerminalLinkBuffer,
  position: TerminalLinkBufferPosition,
  terminalColumns: number
): TerminalFileLinkAtBufferPosition[] {
  const links: TerminalFileLinkAtBufferPosition[] = []
  for (const logicalLine of buildCandidateLogicalLinesForBufferPosition(buffer, position.y)) {
    for (const parsed of extractTerminalFileLinkCandidates(logicalLine.text)) {
      const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
      if (!range || !rangeContainsBufferPosition(range, position, terminalColumns)) {
        continue
      }
      links.push({ ...parsed, logicalLine })
    }
  }
  return links
}

function rangeContainsBufferPosition(
  range: TerminalLinkBufferRange,
  position: TerminalLinkBufferPosition,
  terminalColumns: number
): boolean {
  const lower = range.start.y * terminalColumns + range.start.x
  const upper = range.end.y * terminalColumns + range.end.x
  const current = position.y * terminalColumns + position.x
  return lower <= current && current <= upper
}
