import type { IBufferLine, IBufferRange } from '@xterm/xterm'
import {
  canStartHardWrappedPath,
  getHardWrappedPathPrefix,
  getHardWrappedPathSuffix,
  isHardWrappedPathContinuation,
  isHardWrappedPathFragment,
  isIncompleteHardWrappedPathStart,
  type HardWrappedPathFragmentRow
} from './hard-wrapped-terminal-path-fragments'

type TerminalBufferLineWithColumns = IBufferLine & {
  translateToString(
    trimRight?: boolean,
    startColumn?: number,
    endColumn?: number,
    outColumns?: number[]
  ): string
}

type WrappedLogicalRow = {
  y: number
  text: string
  sourceText: string
  columns: number[]
  startIndex: number
  isWrapped: boolean
  lineLength: number
}

export type WrappedLogicalLine = {
  text: string
  rows: WrappedLogicalRow[]
  fingerprint: string
}

const MAX_SOFT_WRAPPED_LINK_ROWS = 200
const MAX_SOFT_WRAPPED_LINK_CHARS = 20_000

function translateLineWithCells(line: IBufferLine): { text: string; columns: number[] } | null {
  let text = ''
  const columns: number[] = []
  let endColumn = 0

  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell) {
      return null
    }

    const width = cell.getWidth()
    if (width === 0) {
      continue
    }

    const chars = cell.getChars() || ' '
    text += chars
    for (let i = 0; i < chars.length; i++) {
      columns.push(x)
    }
    endColumn = x + Math.max(width, 1)
  }

  columns.push(endColumn)
  return { text, columns }
}

function translateLineWithColumns(line: IBufferLine): { text: string; columns: number[] } {
  const columns: number[] = []
  const text = (line as TerminalBufferLineWithColumns).translateToString(
    false,
    0,
    undefined,
    columns
  )

  if (columns.length === text.length + 1) {
    return { text, columns }
  }

  const cellTranslation = translateLineWithCells(line)
  if (cellTranslation) {
    return cellTranslation
  }

  return {
    text,
    columns: Array.from({ length: text.length + 1 }, (_value, index) => index)
  }
}

function trimHardWrappedPathRow(line: IBufferLine): HardWrappedPathFragmentRow | null {
  const translated = translateLineWithColumns(line)
  const startIndex = translated.text.search(/\S/)
  if (startIndex === -1) {
    return null
  }

  let endIndex = translated.text.length
  while (endIndex > startIndex && /\s/.test(translated.text[endIndex - 1])) {
    endIndex--
  }

  return {
    text: translated.text.slice(startIndex, endIndex),
    sourceText: translated.text,
    columns: translated.columns.slice(startIndex, endIndex + 1),
    isWrapped: line.isWrapped,
    lineLength: line.length
  }
}

function toWrappedLogicalRow(
  row: HardWrappedPathFragmentRow,
  y: number,
  startIndex: number
): WrappedLogicalRow {
  return {
    y,
    text: row.text,
    sourceText: row.sourceText,
    columns: row.columns,
    startIndex,
    isWrapped: row.isWrapped,
    lineLength: row.lineLength
  }
}

function getWrappedRowsFingerprint(rows: WrappedLogicalRow[]): string {
  return rows
    .map(
      (row) => `${row.y}:${row.isWrapped ? 1 : 0}:${row.lineLength}:${row.sourceText}\0${row.text}`
    )
    .join('\n')
}

function toWrappedLogicalLine(rows: WrappedLogicalRow[], text: string): WrappedLogicalLine {
  return { text, rows: [...rows], fingerprint: getWrappedRowsFingerprint(rows) }
}

export function buildWrappedLogicalLine(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number
): WrappedLogicalLine | null {
  const y = bufferLineNumber - 1
  if (!buffer.getLine(y)) {
    return null
  }

  let startY = y
  let rowCount = 1
  while (startY > 0 && buffer.getLine(startY)?.isWrapped) {
    if (rowCount >= MAX_SOFT_WRAPPED_LINK_ROWS) {
      return null
    }
    startY--
    rowCount++
  }

  let endY = y
  while (buffer.getLine(endY + 1)?.isWrapped) {
    if (rowCount >= MAX_SOFT_WRAPPED_LINK_ROWS) {
      return null
    }
    endY++
    rowCount++
  }

  let text = ''
  const rows: WrappedLogicalRow[] = []
  for (let rowY = startY; rowY <= endY; rowY++) {
    const line = buffer.getLine(rowY)
    if (!line) {
      return null
    }
    const translated = translateLineWithColumns(line)
    // Why: terminal hover runs on the renderer interaction path; enormous
    // no-newline blobs are not useful file links and can freeze the window.
    if (text.length + translated.text.length > MAX_SOFT_WRAPPED_LINK_CHARS) {
      return null
    }
    rows.push({
      y: rowY,
      text: translated.text,
      sourceText: translated.text,
      columns: translated.columns,
      startIndex: text.length,
      isWrapped: line.isWrapped,
      lineLength: line.length
    })
    text += translated.text
  }

  return toWrappedLogicalLine(rows, text)
}

export function buildHardWrappedPathLogicalLineCandidates(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number,
  maxRows = 20
): WrappedLogicalLine[] {
  // Why: agent TUIs may hard-wrap long paths into separate terminal rows, so
  // xterm's isWrapped metadata is absent even though the visible path continues.
  const currentY = bufferLineNumber - 1
  if (!buffer.getLine(currentY)) {
    return []
  }

  const minY = Math.max(0, currentY - maxRows + 1)
  const candidates: WrappedLogicalLine[] = []
  for (let startY = currentY; startY >= minY; startY--) {
    const startLine = buffer.getLine(startY)
    const start = startLine ? trimHardWrappedPathRow(startLine) : null
    if (!start) {
      continue
    }
    const canStartWholeRow = canStartHardWrappedPath(start.text)
    const startSuffix = getHardWrappedPathSuffix(start)
    const canStartBoundary = Boolean(
      startSuffix &&
      (canStartHardWrappedPath(startSuffix.text) ||
        isIncompleteHardWrappedPathStart(startSuffix.text))
    )
    // Why: hover calls this for every terminal row; reject non-path starts
    // before translating their possible continuation rows.
    if (!canStartWholeRow && !canStartBoundary) {
      continue
    }

    const sourceRows: { row: HardWrappedPathFragmentRow; y: number }[] = [{ row: start, y: startY }]
    for (let rowY = startY + 1; rowY < startY + maxRows; rowY++) {
      const line = buffer.getLine(rowY)
      const row = line ? trimHardWrappedPathRow(line) : null
      if (!row) {
        break
      }
      sourceRows.push({ row, y: rowY })
      if (!isHardWrappedPathContinuation(row.text)) {
        break
      }
    }

    let lastWholeCandidateText: string | null = null
    if (canStartWholeRow) {
      let text = ''
      const rows: WrappedLogicalRow[] = []
      for (const sourceRow of sourceRows) {
        if (sourceRow.y > startY && !isHardWrappedPathFragment(sourceRow.row.text)) {
          break
        }
        rows.push(toWrappedLogicalRow(sourceRow.row, sourceRow.y, text.length))
        text += sourceRow.row.text
        if (sourceRow.y >= currentY) {
          candidates.push(toWrappedLogicalLine(rows, text))
          lastWholeCandidateText = text
        }
      }
    }

    if (!startSuffix || !canStartBoundary) {
      continue
    }
    let boundaryText = startSuffix.text
    const boundaryRows = [toWrappedLogicalRow(startSuffix, startY, 0)]
    let reachedMixedContinuation = false
    for (let rowIndex = 1; rowIndex < sourceRows.length; rowIndex++) {
      const sourceRow = sourceRows[rowIndex]
      if (isHardWrappedPathContinuation(sourceRow.row.text)) {
        boundaryRows.push(toWrappedLogicalRow(sourceRow.row, sourceRow.y, boundaryText.length))
        boundaryText += sourceRow.row.text
        continue
      }

      reachedMixedContinuation = true
      const finalPrefix = getHardWrappedPathPrefix(sourceRow.row)
      if (finalPrefix && finalPrefix.text.length < sourceRow.row.text.length) {
        boundaryRows.push(toWrappedLogicalRow(finalPrefix, sourceRow.y, boundaryText.length))
        boundaryText += finalPrefix.text
        if (sourceRow.y >= currentY && canStartHardWrappedPath(boundaryText)) {
          // Why: only the first mixed continuation can close a hard-wrapped path;
          // emitting more boundary combinations can merge sibling links.
          candidates.push(toWrappedLogicalLine(boundaryRows, boundaryText))
        }
      }
      break
    }

    const lastBoundaryRow = boundaryRows.at(-1)!
    if (
      !reachedMixedContinuation &&
      isIncompleteHardWrappedPathStart(startSuffix.text) &&
      boundaryRows.length >= 2 &&
      lastBoundaryRow.y >= currentY &&
      canStartHardWrappedPath(boundaryText) &&
      lastWholeCandidateText !== boundaryText
    ) {
      candidates.push(toWrappedLogicalLine(boundaryRows, boundaryText))
    }
  }

  return candidates.sort((left, right) => right.rows.length - left.rows.length)
}

function mapLogicalIndexToBufferPosition(
  logicalLine: WrappedLogicalLine,
  index: number,
  bias: 'start' | 'end'
): { x: number; y: number } | null {
  for (let rowIndex = 0; rowIndex < logicalLine.rows.length; rowIndex++) {
    const row = logicalLine.rows[rowIndex]
    const rowStart = row.startIndex
    const rowEnd = rowStart + row.text.length
    const isTarget =
      bias === 'start'
        ? index < rowEnd || (index === rowEnd && rowIndex === logicalLine.rows.length - 1)
        : index <= rowEnd && (index > rowStart || rowIndex === 0)

    if (!isTarget) {
      continue
    }

    const localIndex = Math.max(0, Math.min(index - rowStart, row.columns.length - 1))
    const column = row.columns[localIndex] ?? localIndex
    return { x: column, y: row.y + 1 }
  }

  return null
}

export function rangeForParsedFileLink(
  logicalLine: WrappedLogicalLine,
  startIndex: number,
  endIndex: number
): IBufferRange | null {
  const start = mapLogicalIndexToBufferPosition(logicalLine, startIndex, 'start')
  const end = mapLogicalIndexToBufferPosition(logicalLine, endIndex, 'end')
  if (!start || !end) {
    return null
  }

  return {
    // Why: xterm's link hit-test uses 1-based inclusive coordinates, while
    // parsed file links use zero-based half-open string indexes.
    start: { x: start.x + 1, y: start.y },
    end: { x: end.x, y: end.y }
  }
}
