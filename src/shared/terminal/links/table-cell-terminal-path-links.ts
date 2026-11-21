import {
  toWrappedLogicalLine,
  translateLineWithColumns,
  type WrappedLogicalLine,
  type WrappedLogicalRow
} from './wrapped-terminal-link-ranges'
import type { TerminalLinkBuffer } from './terminal-link-buffer'

// Why box-drawing only: an ASCII `|` is as likely a shell pipe as a table border.
const TABLE_CELL_FRAME_PATTERN = /[│┃║]/
const MAX_TABLE_CELL_ROWS = 20

type FramedRow = {
  y: number
  text: string
  columns: number[]
  isWrapped: boolean
  lineLength: number
  frameIndexes: number[]
  frameColumns: number[]
}

type CellSlice = { startIndex: number; endIndex: number }

function readFramedRow(buffer: TerminalLinkBuffer, y: number): FramedRow | null {
  const line = y >= 0 ? buffer.getLine(y) : undefined
  if (!line) {
    return null
  }
  const { text, columns } = translateLineWithColumns(line)
  const frameIndexes: number[] = []
  for (let index = 0; index < text.length; index++) {
    if (TABLE_CELL_FRAME_PATTERN.test(text[index]!)) {
      frameIndexes.push(index)
    }
  }
  if (frameIndexes.length < 2) {
    return null
  }
  return {
    y,
    text,
    columns,
    isWrapped: line.isWrapped,
    lineLength: line.length,
    frameIndexes,
    frameColumns: frameIndexes.map((index) => columns[index]!)
  }
}

function hasSameFrames(left: FramedRow, right: FramedRow): boolean {
  return (
    left.frameColumns.length === right.frameColumns.length &&
    left.frameColumns.every((column, index) => right.frameColumns[index] === column)
  )
}

function cellSlice(row: FramedRow, cell: number): CellSlice | null {
  let startIndex = row.frameIndexes[cell]! + 1
  let endIndex = row.frameIndexes[cell + 1]!
  while (startIndex < endIndex && /\s/.test(row.text[startIndex]!)) {
    startIndex++
  }
  while (endIndex > startIndex && /\s/.test(row.text[endIndex - 1]!)) {
    endIndex--
  }
  return startIndex < endIndex ? { startIndex, endIndex } : null
}

/**
 * Agent TUIs (Claude Code's markdown tables among them) wrap long cell text onto
 * extra table rows, so a path in a cell continues on the next row between the same
 * borders while the row's own text runs on into the neighbouring cells.
 */
export function buildTableCellPathLogicalLineCandidates(
  buffer: TerminalLinkBuffer,
  bufferLineNumber: number
): WrappedLogicalLine[] {
  const currentY = bufferLineNumber - 1
  const current = readFramedRow(buffer, currentY)
  if (!current) {
    return []
  }

  const candidates: WrappedLogicalLine[] = []
  for (let cell = 0; cell < current.frameIndexes.length - 1; cell++) {
    if (!cellSlice(current, cell)) {
      continue
    }
    // Why stop at a blank cell or a different border: that is where the cell's text ends
    // (a separator row such as `├──┼──┤` has no vertical border at all).
    const sameCellRow = (y: number): { row: FramedRow; slice: CellSlice } | null => {
      const row = readFramedRow(buffer, y)
      const slice = row && hasSameFrames(row, current) ? cellSlice(row, cell) : null
      return row && slice ? { row, slice } : null
    }
    const cellRows = [{ row: current, slice: cellSlice(current, cell)! }]
    for (let y = currentY - 1; cellRows.length < MAX_TABLE_CELL_ROWS; y--) {
      const above = sameCellRow(y)
      if (!above) {
        break
      }
      cellRows.unshift(above)
    }
    for (let y = currentY + 1; cellRows.length < MAX_TABLE_CELL_ROWS; y++) {
      const below = sameCellRow(y)
      if (!below) {
        break
      }
      cellRows.push(below)
    }
    if (cellRows.length < 2) {
      continue
    }

    let text = ''
    const rows: WrappedLogicalRow[] = []
    cellRows.forEach(({ row, slice }, index) => {
      let rowText = row.text.slice(slice.startIndex, slice.endIndex)
      const columns = row.columns.slice(slice.startIndex, slice.endIndex + 1)
      // oxlint-disable-next-line unicorn/prefer-at -- the phone's terminal WebView (Chrome 74) has no Array#at
      const endColumn = columns[columns.length - 1]!
      const rightFrameColumn = row.frameColumns[cell + 1]!
      // Why: text that fills the cell up to its padding was broken mid-word; shorter
      // text was wrapped at a space, which the joined reading must keep.
      const filledCell = endColumn >= rightFrameColumn - 1
      if (index < cellRows.length - 1 && !filledCell) {
        rowText += ' '
        columns.push(endColumn + 1)
      }
      rows.push({
        y: row.y,
        text: rowText,
        sourceText: row.text,
        columns,
        startIndex: text.length,
        isWrapped: row.isWrapped,
        lineLength: row.lineLength
      })
      text += rowText
    })
    candidates.push({ ...toWrappedLogicalLine(rows, text), rowScopedLinks: true })
  }
  return candidates
}
