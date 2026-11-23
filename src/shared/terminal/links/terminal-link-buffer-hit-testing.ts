import { buildTerminalHttpLogicalLines, hasHardWrappedRows } from './terminal-http-logical-lines'
import { extractTerminalHttpLinks } from './terminal-http-url-extraction'
import { dedupeLogicalLines } from './terminal-link-logical-line-deduplication'
import { rangeForParsedLinkOnRow } from './terminal-link-row-range'
import { extractTerminalFileLinkReadings, type ParsedTerminalFileLink } from './terminal-links'
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

/** The readings covering the cell; a guess needs the host to find its file before anyone acts on it. */
export function findTerminalFileLinksAtBufferPosition(
  buffer: TerminalLinkBuffer,
  position: TerminalLinkBufferPosition,
  terminalColumns: number
): { links: TerminalFileLinkAtBufferPosition[]; guesses: TerminalFileLinkAtBufferPosition[] } {
  const links: TerminalFileLinkAtBufferPosition[] = []
  const guesses: TerminalFileLinkAtBufferPosition[] = []
  for (const logicalLine of buildCandidateLogicalLinesForBufferPosition(buffer, position.y)) {
    const readings = extractTerminalFileLinkReadings(logicalLine.text)
    const covering = (parsed: ParsedTerminalFileLink): boolean => {
      const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
      return range !== null && rangeContainsBufferPosition(range, position, terminalColumns)
    }
    for (const parsed of readings.links.filter(covering)) {
      links.push({ ...parsed, logicalLine })
    }
    for (const parsed of readings.guesses.filter(covering)) {
      guesses.push({ ...parsed, logicalLine })
    }
  }
  return { links, guesses }
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
