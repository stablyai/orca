import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm'

export type TerminalImeAnchor = {
  row: number
  column: number
}

const CURSOR_AGENT_HEADER = 'Cursor Agent'
const CURSOR_AGENT_INPUT_MARKER = '→'
const CURSOR_AGENT_EMPTY_PROMPTS = ['Plan, search, build anything', 'Add a follow-up'] as const
const CURSOR_AGENT_HEADER_SCAN_ROWS = 6

export function resolveCursorAgentImeAnchor(args: {
  buffer: IBuffer
  rows: number
  cols: number
  cursorX: number
  cursorY: number
  knownCursorAgent?: boolean
  /** A previously resolved prompt row, checked in one row read before rescanning the screen. */
  promptRow?: number
}): TerminalImeAnchor | null {
  const cursorLine = getVisibleLine(args.buffer, args.cursorY)
  if (args.cursorX !== 0 || !isBlankLine(cursorLine)) {
    return null
  }
  // A cached row was resolved as Cursor Agent, so typed input is allowed like knownCursorAgent.
  const cachedAnchor =
    args.promptRow === undefined
      ? null
      : resolveRowInputAnchor(args.buffer, args.promptRow, args.cols, true)
  return cachedAnchor ?? findCursorAgentScreenInputAnchor(args)
}

function findCursorAgentScreenInputAnchor(args: {
  buffer: IBuffer
  rows: number
  cols: number
  knownCursorAgent?: boolean
}): TerminalImeAnchor | null {
  const allowTypedInput = Boolean(
    args.knownCursorAgent || hasCursorAgentHeader(args.buffer, args.rows)
  )

  // Find the bottom-most prompt; transcript arrows (e.g. rename diffs) must not become the input anchor.
  for (let row = args.rows - 1; row >= 0; row--) {
    const anchor = resolveRowInputAnchor(args.buffer, row, args.cols, allowTypedInput)
    if (anchor) {
      return anchor
    }
  }

  return null
}

function resolveRowInputAnchor(
  buffer: IBuffer,
  row: number,
  cols: number,
  allowTypedInput: boolean
): TerminalImeAnchor | null {
  const line = getVisibleLine(buffer, row)
  const column = line ? resolveCursorAgentInputColumn(line, cols, allowTypedInput) : null
  return column === null ? null : { row, column: Math.min(column, Math.max(cols - 1, 0)) }
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

function resolveCursorAgentInputColumn(
  line: IBufferLine,
  cols: number,
  allowTypedInput: boolean
): number | null {
  const inputColumn = findCursorAgentInputStartColumn(line, cols)
  if (inputColumn === null) {
    return null
  }

  const inputText = line.translateToString(true, inputColumn, cols)
  const isEmptyPrompt = CURSOR_AGENT_EMPTY_PROMPTS.some((prompt) => inputText.startsWith(prompt))
  if (!inputText.trim() || isEmptyPrompt) {
    return inputColumn
  }
  if (!allowTypedInput) {
    return null
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
