import type { TerminalCursorContext } from './terminal-composer-draft'

type TerminalCursorCell = {
  getChars(): string
  getWidth(): number
  isBold(): boolean | number
  isDim(): boolean | number
  isFgDefault(): boolean | number
}

type TerminalCursorLine<Cell extends TerminalCursorCell> = {
  readonly isWrapped: boolean
  readonly length: number
  getCell(column: number, reusableCell?: Cell): Cell | undefined
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export type TerminalCursorContextSource<Cell extends TerminalCursorCell = TerminalCursorCell> = {
  readonly rows: number
  readonly modes: { readonly showCursor: boolean }
  readonly buffer: {
    readonly active: {
      readonly baseY: number
      readonly cursorX: number
      readonly cursorY: number
      readonly viewportY: number
      getLine(row: number): TerminalCursorLine<Cell> | undefined
      getNullCell?(): Cell
    }
  }
}

function undimmedText<Cell extends TerminalCursorCell>(
  line: TerminalCursorLine<Cell>,
  fromX = 0,
  trimRight = true,
  reusableCell?: Cell
): string {
  let text = ''
  for (let x = fromX; x < line.length; x += 1) {
    const cell = line.getCell(x, reusableCell)
    if (!cell || cell.isDim() || cell.getWidth() === 0) {
      continue
    }
    text += cell.getChars() || ' '
  }
  return trimRight ? text.trimEnd() : text
}

function readUndimmedTextAndFirstVisibleStyle<Cell extends TerminalCursorCell>(
  line: TerminalCursorLine<Cell>,
  trimRight: boolean,
  style: 'bold' | 'customForeground',
  reusableCell?: Cell
): { text: string; firstVisibleStyle: boolean } {
  let text = ''
  let firstVisibleStyle = false
  let foundVisibleCell = false
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x, reusableCell)
    if (!cell || cell.getWidth() === 0) {
      continue
    }
    const chars = cell.getChars()
    if (!foundVisibleCell && chars.trim()) {
      firstVisibleStyle = style === 'bold' ? Boolean(cell.isBold()) : !cell.isFgDefault()
      foundVisibleCell = true
    }
    if (!cell.isDim()) {
      text += chars || ' '
    }
  }
  return { text: trimRight ? text.trimEnd() : text, firstVisibleStyle }
}

export function readTerminalCursorLineContext<Cell extends TerminalCursorCell>(
  terminal: TerminalCursorContextSource<Cell>,
  rowsAroundCursor: number
): TerminalCursorContext | null {
  const buffer = terminal.buffer.active
  const cursorRow = buffer.baseY + buffer.cursorY
  const cursorLine = buffer.getLine(cursorRow)
  if (!cursorLine) {
    return null
  }
  const reusableCell = buffer.getNullCell?.()
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
    const scan = line
      ? readUndimmedTextAndFirstVisibleStyle(line, !nextLineIsWrapped, 'bold', reusableCell)
      : undefined
    typedRows.push(scan?.text ?? '')
    promptGlyphBoldRows.push(scan?.firstVisibleStyle ?? false)
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
    const scan = line
      ? readUndimmedTextAndFirstVisibleStyle(
          line,
          !nextLineIsWrapped,
          'customForeground',
          reusableCell
        )
      : undefined
    typedRowsBelow.push(scan?.text ?? '')
    rowsBelowWrapped.push(line?.isWrapped ?? false)
    rowsBelowCustomForeground.push(scan?.firstVisibleStyle ?? false)
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
      !(buffer.getLine(cursorRow + 1)?.isWrapped ?? false),
      reusableCell
    ),
    rawAfterCursor: cursorLine.translateToString(
      !(buffer.getLine(cursorRow + 1)?.isWrapped ?? false),
      buffer.cursorX
    ),
    cursorHidden: !terminal.modes.showCursor,
    cursorViewportRow: cursorRow - buffer.viewportY
  }
}

/** PSReadLine repaint requires an empty prompt, excluding its continuation prompt. */
export function isTerminalCursorOnEmptyPromptLine(terminal: TerminalCursorContextSource): boolean {
  const buffer = terminal.buffer.active
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)
  if (!line) {
    return false
  }
  const upToCursor = line.translateToString(true, 0, buffer.cursorX).trimEnd()
  const fullLine = line.translateToString(true).trimEnd()
  return fullLine === upToCursor && upToCursor.endsWith('>') && !upToCursor.endsWith('>>')
}
