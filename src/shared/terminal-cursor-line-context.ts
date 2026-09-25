import type { TerminalCursorContext } from './terminal-composer-draft'

type TerminalCursorCell = {
  getChars(): string
  getWidth(): number
  isBold(): boolean | number
  isDim(): boolean | number
  isFgDefault(): boolean | number
}

type TerminalCursorLine = {
  readonly isWrapped: boolean
  readonly length: number
  getCell(column: number): TerminalCursorCell | undefined
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export type TerminalCursorContextSource = {
  readonly rows: number
  readonly modes: { readonly showCursor: boolean }
  readonly buffer: {
    readonly active: {
      readonly baseY: number
      readonly cursorX: number
      readonly cursorY: number
      readonly viewportY: number
      getLine(row: number): TerminalCursorLine | undefined
    }
  }
}

function undimmedText(line: TerminalCursorLine, fromX = 0, trimRight = true): string {
  let text = ''
  for (let x = fromX; x < line.length; x += 1) {
    const cell = line.getCell(x)
    if (!cell || cell.isDim() || cell.getWidth() === 0) {
      continue
    }
    text += cell.getChars() || ' '
  }
  return trimRight ? text.trimEnd() : text
}

function firstVisibleCellIsBold(line: TerminalCursorLine): boolean {
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0 || !cell.getChars().trim()) {
      continue
    }
    return Boolean(cell.isBold())
  }
  return false
}

function firstVisibleCellHasCustomForeground(line: TerminalCursorLine): boolean {
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0 || !cell.getChars().trim()) {
      continue
    }
    return !cell.isFgDefault()
  }
  return false
}

export function readTerminalCursorLineContext(
  terminal: TerminalCursorContextSource,
  rowsAroundCursor: number
): TerminalCursorContext | null {
  const buffer = terminal.buffer.active
  const cursorRow = buffer.baseY + buffer.cursorY
  const cursorLine = buffer.getLine(cursorRow)
  if (!cursorLine) {
    return null
  }
  const rows: string[] = []
  const typedRows: string[] = []
  const promptGlyphBoldRows: boolean[] = []
  const rowsWrapped: boolean[] = []
  const rowRadius = Math.max(0, Math.floor(rowsAroundCursor))
  const start = Math.max(buffer.viewportY, cursorRow - rowRadius)
  for (let row = start; row <= cursorRow; row += 1) {
    const line = buffer.getLine(row)
    const nextLineIsWrapped = buffer.getLine(row + 1)?.isWrapped ?? false
    rows.push(line?.translateToString(!nextLineIsWrapped) ?? '')
    typedRows.push(line ? undimmedText(line, 0, !nextLineIsWrapped) : '')
    promptGlyphBoldRows.push(line ? firstVisibleCellIsBold(line) : false)
    rowsWrapped.push(line?.isWrapped ?? false)
  }
  const rowsBelow: string[] = []
  const typedRowsBelow: string[] = []
  const rowsBelowWrapped: boolean[] = []
  const rowsBelowCustomForeground: boolean[] = []
  const end = Math.min(buffer.viewportY + terminal.rows - 1, cursorRow + rowRadius)
  for (let row = cursorRow + 1; row <= end; row += 1) {
    const line = buffer.getLine(row)
    const nextLineIsWrapped = buffer.getLine(row + 1)?.isWrapped ?? false
    rowsBelow.push(line?.translateToString(!nextLineIsWrapped) ?? '')
    typedRowsBelow.push(line ? undimmedText(line, 0, !nextLineIsWrapped) : '')
    rowsBelowWrapped.push(line?.isWrapped ?? false)
    rowsBelowCustomForeground.push(line ? firstVisibleCellHasCustomForeground(line) : false)
  }
  return {
    rows,
    typedRows,
    promptGlyphBoldRows,
    rowsWrapped,
    rowsBelow,
    typedRowsBelow,
    rowsBelowWrapped,
    rowsBelowCustomForeground,
    beforeCursor: cursorLine.translateToString(true, 0, buffer.cursorX),
    afterCursor: undimmedText(
      cursorLine,
      buffer.cursorX,
      !(buffer.getLine(cursorRow + 1)?.isWrapped ?? false)
    ),
    rawAfterCursor: cursorLine.translateToString(
      !(buffer.getLine(cursorRow + 1)?.isWrapped ?? false),
      buffer.cursorX
    ),
    cursorHidden: !terminal.modes.showCursor,
    cursorViewportRow: cursorRow - buffer.viewportY
  }
}
