import type { TerminalCursorContext } from './terminal-composer-draft'
import {
  getClippedTerminalLineColumns,
  translateClippedTerminalLine,
  type ClippedTerminalLineColumns
} from '../viewport/terminal-line-applied-columns'

type TerminalCursorCell = {
  getChars(): string
  getWidth(): number
  isBold(): boolean | number
  isDim(): boolean | number
  isFgDefault(): boolean | number
  isInverse(): boolean | number
}

type TerminalCursorLine<Cell extends TerminalCursorCell> = {
  readonly isWrapped: boolean
  readonly length: number
  getCell(column: number, reusableCell?: Cell): Cell | undefined
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export type TerminalCursorContextSource<Cell extends TerminalCursorCell = TerminalCursorCell> = {
  readonly cols: number
  readonly rows: number
  readonly modes: { readonly showCursor: boolean }
  readonly buffer: {
    readonly active: {
      readonly type?: 'normal' | 'alternate'
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
  clipped: ClippedTerminalLineColumns | undefined,
  fromX: number,
  trimRight: boolean,
  reusableCell?: Cell
): string {
  let text = ''
  const end = clipped?.textEnd ?? line.length
  for (let x = fromX; x < end; x += 1) {
    const cell = line.getCell(x, reusableCell)
    if (!cell || cell.isDim() || cell.getWidth() === 0) {
      continue
    }
    text += cell.getChars() || ' '
  }
  if (!trimRight && clipped?.splitWideCell && fromX <= end) {
    text += ' '
  }
  return trimRight ? text.trimEnd() : text
}

function readUndimmedTextAndFirstVisibleStyle<Cell extends TerminalCursorCell>(
  line: TerminalCursorLine<Cell>,
  clipped: ClippedTerminalLineColumns | undefined,
  trimRight: boolean,
  style: 'bold' | 'customForeground',
  reusableCell?: Cell
): { text: string; firstVisibleStyle: boolean } {
  let text = ''
  let firstVisibleStyle = false
  let foundVisibleCell = false
  const end = clipped?.textEnd ?? line.length
  for (let x = 0; x < end; x += 1) {
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
  if (!trimRight && clipped?.splitWideCell) {
    text += ' '
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
  const cols = terminal.cols
  const cursorColumns = getClippedTerminalLineColumns(cursorLine, cols, reusableCell)
  const cursorHidden = !terminal.modes.showCursor
  // Why: a hidden native cursor needs screen evidence, read from the cursor cell alone and only then.
  const hiddenCursorEvidence = cursorHidden
    ? {
        activeBuffer: buffer.type,
        cursorInverse:
          buffer.cursorX < (cursorColumns?.textEnd ?? cursorLine.length) &&
          Boolean(cursorLine.getCell(buffer.cursorX, reusableCell)?.isInverse())
      }
    : {}
  const rows: string[] = []
  const typedRows: string[] = []
  const promptGlyphBoldRows: boolean[] = []
  const rowsWrapped: boolean[] = []
  const rowRadius = Math.max(0, Math.floor(rowsAroundCursor))
  // The cursor lives on the live screen; bound by it, not the viewport, so scrollback doesn't cut the input.
  const start = Math.max(buffer.baseY, cursorRow - rowRadius)
  for (let row = start; row <= cursorRow; row += 1) {
    const line = buffer.getLine(row)
    const trimRight = !(buffer.getLine(row + 1)?.isWrapped ?? false)
    const clipped =
      row === cursorRow
        ? cursorColumns
        : line && getClippedTerminalLineColumns(line, cols, reusableCell)
    rows.push(
      line && clipped
        ? translateClippedTerminalLine(line, clipped, trimRight, reusableCell)
        : (line?.translateToString(trimRight) ?? '')
    )
    const scan = line
      ? readUndimmedTextAndFirstVisibleStyle(line, clipped, trimRight, 'bold', reusableCell)
      : undefined
    typedRows.push(scan?.text ?? '')
    promptGlyphBoldRows.push(scan?.firstVisibleStyle ?? false)
    rowsWrapped.push(line?.isWrapped ?? false)
  }
  const rowsBelow: string[] = []
  const typedRowsBelow: string[] = []
  const rowsBelowWrapped: boolean[] = []
  const rowsBelowCustomForeground: boolean[] = []
  const end = Math.min(buffer.baseY + terminal.rows - 1, cursorRow + rowRadius)
  for (let row = cursorRow + 1; row <= end; row += 1) {
    const line = buffer.getLine(row)
    const trimRight = !(buffer.getLine(row + 1)?.isWrapped ?? false)
    const clipped = line && getClippedTerminalLineColumns(line, cols, reusableCell)
    rowsBelow.push(
      line && clipped
        ? translateClippedTerminalLine(line, clipped, trimRight, reusableCell)
        : (line?.translateToString(trimRight) ?? '')
    )
    const scan = line
      ? readUndimmedTextAndFirstVisibleStyle(
          line,
          clipped,
          trimRight,
          'customForeground',
          reusableCell
        )
      : undefined
    typedRowsBelow.push(scan?.text ?? '')
    rowsBelowWrapped.push(line?.isWrapped ?? false)
    rowsBelowCustomForeground.push(scan?.firstVisibleStyle ?? false)
  }
  const trimAfterCursor = !(buffer.getLine(cursorRow + 1)?.isWrapped ?? false)
  return {
    rows,
    typedRows,
    promptGlyphBoldRows,
    rowsWrapped,
    rowsBelow,
    typedRowsBelow,
    rowsBelowWrapped,
    rowsBelowCustomForeground,
    beforeCursor: cursorColumns
      ? translateClippedTerminalLine(
          cursorLine,
          cursorColumns,
          true,
          reusableCell,
          0,
          buffer.cursorX
        )
      : cursorLine.translateToString(true, 0, buffer.cursorX),
    afterCursor: undimmedText(
      cursorLine,
      cursorColumns,
      buffer.cursorX,
      trimAfterCursor,
      reusableCell
    ),
    rawAfterCursor: cursorColumns
      ? translateClippedTerminalLine(
          cursorLine,
          cursorColumns,
          trimAfterCursor,
          reusableCell,
          buffer.cursorX
        )
      : cursorLine.translateToString(trimAfterCursor, buffer.cursorX),
    cursorHidden,
    cursorViewportRow: cursorRow - buffer.viewportY,
    ...hiddenCursorEvidence
  }
}
