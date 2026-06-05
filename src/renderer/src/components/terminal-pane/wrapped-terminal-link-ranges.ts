import type { IBufferLine, IBufferRange } from '@xterm/xterm'

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

function trimHardWrappedPathRow(line: IBufferLine): { text: string; columns: number[] } | null {
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
    columns: translated.columns.slice(startIndex, endIndex + 1)
  }
}

const HARD_WRAPPED_PATH_FRAGMENT_PATTERN = /^[A-Za-z0-9._~@%+=:,/\\-]+$/

function isHardWrappedPathFragment(text: string): boolean {
  return HARD_WRAPPED_PATH_FRAGMENT_PATTERN.test(text) && /[A-Za-z0-9]/.test(text)
}

function canStartHardWrappedPath(text: string): boolean {
  if (!isHardWrappedPathFragment(text)) {
    return /(?:^|[\s•*>-])(?:\/|\.{1,2}\/|[A-Za-z0-9._-]+\/)[A-Za-z0-9._~@%+=:,/\\-]*$/.test(text)
  }

  return /(?:\/|\\)/.test(text)
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
      columns: translated.columns,
      startIndex: text.length,
      isWrapped: line.isWrapped,
      lineLength: line.length
    })
    text += translated.text
  }

  const fingerprint = rows
    .map((row) => `${row.y}:${row.isWrapped ? 1 : 0}:${row.lineLength}:${row.text}`)
    .join('\n')
  return { text, rows, fingerprint }
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
    if (!start || !canStartHardWrappedPath(start.text)) {
      continue
    }

    let text = ''
    const rows: WrappedLogicalRow[] = []
    for (let rowY = startY; rowY < startY + maxRows; rowY++) {
      const line = buffer.getLine(rowY)
      const translated = line ? trimHardWrappedPathRow(line) : null
      if (!translated) {
        break
      }
      if (rowY > startY && !isHardWrappedPathFragment(translated.text)) {
        break
      }

      rows.push({
        y: rowY,
        text: translated.text,
        columns: translated.columns,
        startIndex: text.length,
        isWrapped: line?.isWrapped ?? false,
        lineLength: line?.length ?? translated.text.length
      })
      text += translated.text

      if (rowY >= currentY) {
        const fingerprint = rows
          .map((row) => `${row.y}:${row.isWrapped ? 1 : 0}:${row.lineLength}:${row.text}`)
          .join('\n')
        candidates.push({ text, rows: [...rows], fingerprint })
      }
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
