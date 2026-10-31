import type { Terminal } from '@xterm/xterm'
import type { TerminalCopyModeMotion } from '../../../../shared/terminal-copy-mode-config'
import {
  createCopyModeBuffer,
  type CopyModeBuffer,
  type CopyModePosition,
  type CopyModeTerminal
} from './terminal-copy-mode-buffer'
import { moveCopyModeWord } from './terminal-copy-mode-word-motion'

export type { CopyModePosition } from './terminal-copy-mode-buffer'
export type CopyModeSelection = {
  cursor: CopyModePosition
  anchor: CopyModePosition | null
  preferredColumn: number
  buffer: CopyModeBuffer
}

export function createCopyModeSelection(
  terminal: CopyModeTerminal,
  position: CopyModePosition
): CopyModeSelection {
  const buffer = createCopyModeBuffer(terminal)
  const cursor = buffer.characterStart(position.row, position.column)
  return { cursor, anchor: null, preferredColumn: buffer.logicalColumn(cursor), buffer }
}

export function moveCopyModeCursor(
  terminal: Terminal,
  state: CopyModeSelection,
  motion: TerminalCopyModeMotion
): void {
  const { buffer, cursor } = state
  const { start, end } = buffer.lineBounds(cursor.row)
  let next = cursor
  if (motion === 'up' || motion === 'down') {
    const row = motion === 'up' ? start - 1 : end + 1
    if (row >= 0 && row <= buffer.lastRow) {
      state.cursor = buffer.atLogicalColumn(row, state.preferredColumn)
    }
    return
  }
  if (motion === 'left' || motion === 'right') {
    const adjacent = motion === 'left' ? buffer.previous(cursor) : buffer.next(cursor)
    if (adjacent && adjacent.row >= start && adjacent.row <= end) {
      next = adjacent
    }
  } else if (motion === 'lineStart' || motion === 'firstNonBlank') {
    next = { row: start, column: 0 }
    if (motion === 'firstNonBlank') {
      let following = buffer.next(next)
      while (!buffer.text(next).trim() && following && following.row <= end) {
        next = following
        following = buffer.next(next)
      }
      if (!buffer.text(next).trim()) {
        next = { row: start, column: 0 }
      }
    }
  } else if (motion === 'lineEnd' || motion === 'lastNonBlank') {
    next = buffer.characterStart(end, Math.max(0, buffer.rowLength(end) - 1))
    if (motion === 'lastNonBlank') {
      let previous = buffer.previous(next)
      while (!buffer.text(next).trim() && previous && previous.row >= start) {
        next = previous
        previous = buffer.previous(next)
      }
    }
  } else if (motion === 'halfPageUp' || motion === 'halfPageDown') {
    const amount = Math.max(1, Math.floor(terminal.rows / 2)) * (motion === 'halfPageUp' ? -1 : 1)
    const row = Math.max(0, Math.min(buffer.lastRow, cursor.row + amount))
    next = buffer.characterStart(
      row,
      Math.min(cursor.column, Math.max(0, buffer.rowLength(row) - 1))
    )
    terminal.scrollLines(amount)
  } else {
    next = moveCopyModeWord(buffer, cursor, motion)
  }
  state.cursor = next
  state.preferredColumn = buffer.logicalColumn(next)
}

export function renderCopyModeSelection(terminal: Terminal, state: CopyModeSelection): void {
  if (!state.anchor) {
    terminal.clearSelection()
    return
  }
  const linear = (position: CopyModePosition) => position.row * terminal.cols + position.column
  const [start, end] =
    linear(state.anchor) <= linear(state.cursor)
      ? [state.anchor, state.cursor]
      : [state.cursor, state.anchor]
  const endWidth = Math.max(
    1,
    terminal.buffer.active.getLine(end.row)?.getCell(end.column)?.getWidth() ?? 1
  )
  terminal.select(start.column, start.row, linear(end) - linear(start) + endWidth)
}
