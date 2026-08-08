import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm'

const CURSOR_AGENT_HEADER = 'Cursor Agent'
const CURSOR_AGENT_INPUT_MARKER = '→'
const CURSOR_AGENT_HEADER_SCAN_ROWS = 6

export function viewportShowsParkedCursorAgentScreen(args: {
  buffer: IBuffer
  rows: number
  cols: number
  cursorX: number
  cursorY: number
}): boolean {
  if (args.cursorX !== 0 || !isBlankLine(getVisibleLine(args.buffer, args.cursorY))) {
    return false
  }
  return (
    hasCursorAgentHeader(args.buffer, args.rows) &&
    hasCursorAgentInputRow(args.buffer, args.rows, args.cols)
  )
}

function getVisibleLine(buffer: IBuffer, row: number): IBufferLine | undefined {
  return buffer.getLine(buffer.baseY + row)
}

function hasCursorAgentHeader(buffer: IBuffer, rows: number): boolean {
  const scanRows = Math.min(rows, CURSOR_AGENT_HEADER_SCAN_ROWS)
  for (let row = 0; row < scanRows; row++) {
    if (getVisibleLine(buffer, row)?.translateToString(true).trim() === CURSOR_AGENT_HEADER) {
      return true
    }
  }
  return false
}

function hasCursorAgentInputRow(buffer: IBuffer, rows: number, cols: number): boolean {
  for (let row = 0; row < rows; row++) {
    const line = getVisibleLine(buffer, row)
    if (line && hasCursorAgentInputMarker(line, cols)) {
      return true
    }
  }
  return false
}

function hasCursorAgentInputMarker(line: IBufferLine, cols: number): boolean {
  const maxColumn = Math.min(line.length, cols)
  for (let column = 0; column < maxColumn - 1; column++) {
    const markerCell = line.getCell(column)
    if (!isCellChar(markerCell, CURSOR_AGENT_INPUT_MARKER)) {
      continue
    }
    const nextColumn = column + Math.max(markerCell.getWidth(), 1)
    if (nextColumn < maxColumn && isCellChar(line.getCell(nextColumn), ' ')) {
      return true
    }
  }
  return false
}

function isBlankLine(line: IBufferLine | undefined): boolean {
  return !line || line.translateToString(true).trim() === ''
}

function isCellChar(cell: IBufferCell | undefined, expected: string): cell is IBufferCell {
  return !!cell && cell.getWidth() > 0 && (cell.getChars() || ' ') === expected
}
