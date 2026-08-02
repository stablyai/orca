import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm'

export type TerminalImeAnchor = {
  row: number
  column: number
}

const CURSOR_AGENT_HEADER = 'Cursor Agent'
const CURSOR_AGENT_INPUT_MARKER = '→'
const CURSOR_AGENT_EMPTY_PROMPT = 'Plan, search, build anything'
const CURSOR_AGENT_HEADER_SCAN_ROWS = 6

export function resolveCursorAgentImeAnchor(args: {
  buffer: IBuffer
  rows: number
  cols: number
  cursorX: number
  cursorY: number
}): TerminalImeAnchor | null {
  const cursorLine = getVisibleLine(args.buffer, args.cursorY)
  if (args.cursorX !== 0 || !isBlankLine(cursorLine)) {
    return null
  }
  return findCursorAgentScreenInputAnchor(args)
}

function findCursorAgentScreenInputAnchor(args: {
  buffer: IBuffer
  rows: number
  cols: number
}): TerminalImeAnchor | null {
  if (!hasCursorAgentHeader(args.buffer, args.rows)) {
    return null
  }

  // Why: the input box sits below the transcript, so scan bottom-up — a
  // transcript line containing "→ " (e.g. a rename diff) must not win.
  for (let row = args.rows - 1; row >= 0; row--) {
    const line = getVisibleLine(args.buffer, row)
    if (!line) {
      continue
    }
    const column = resolveCursorAgentInputColumn(line, args.cols)
    if (column !== null) {
      return { row, column: Math.min(column, Math.max(args.cols - 1, 0)) }
    }
  }

  return null
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

function resolveCursorAgentInputColumn(line: IBufferLine, cols: number): number | null {
  const inputColumn = findCursorAgentInputStartColumn(line, cols)
  if (inputColumn === null) {
    return null
  }

  const inputText = line.translateToString(true, inputColumn, cols)
  if (!inputText.trim() || inputText.startsWith(CURSOR_AGENT_EMPTY_PROMPT)) {
    return inputColumn
  }

  return findLineContentEndColumn(line, inputColumn, cols) ?? inputColumn
}

function findCursorAgentInputStartColumn(line: IBufferLine, cols: number): number | null {
  const maxColumn = Math.min(line.length, cols)
  for (let column = 0; column < maxColumn - 1; column++) {
    const markerCell = line.getCell(column)
    if (!isCellChar(markerCell, CURSOR_AGENT_INPUT_MARKER)) {
      continue
    }

    const nextColumn = column + Math.max(markerCell.getWidth(), 1)
    if (nextColumn < maxColumn && isCellChar(line.getCell(nextColumn), ' ')) {
      return nextColumn + 1
    }
  }
  return null
}

function findLineContentEndColumn(
  line: IBufferLine,
  startColumn: number,
  cols: number
): number | null {
  const maxColumn = Math.min(line.length, cols)
  for (let column = maxColumn - 1; column >= startColumn; column--) {
    const cell = line.getCell(column)
    if (!cell || cell.getWidth() === 0 || getCellChars(cell) === ' ') {
      continue
    }
    return column + Math.max(cell.getWidth(), 1)
  }
  return null
}

function isBlankLine(line: IBufferLine | undefined): boolean {
  return !line || line.translateToString(true).trim() === ''
}

function isCellChar(cell: IBufferCell | undefined, expected: string): cell is IBufferCell {
  return !!cell && cell.getWidth() > 0 && getCellChars(cell) === expected
}

function getCellChars(cell: IBufferCell): string {
  return cell.getChars() || ' '
}
