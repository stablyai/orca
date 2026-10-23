import type { Terminal } from '@xterm/xterm'
import { readReflowedRowCellCount } from '@/lib/pane-manager/terminal-reflow-scroll-anchor'

export type CopyModePosition = { row: number; column: number }
export type CopyModeTerminal = Pick<Terminal, 'buffer' | 'cols' | 'rows'>

export function createCopyModeBuffer(terminal: CopyModeTerminal) {
  const buffer = terminal.buffer.active
  const lengths = new Map<number, number>()
  const wrapped = (row: number): boolean => buffer.getLine(row)?.isWrapped === true
  const metrics = {
    isWrapped: wrapped,
    getCellMetrics: (row: number, column: number) => {
      const cell = buffer.getLine(row)?.getCell(column)
      return cell ? { code: cell.getCode(), width: cell.getWidth() } : undefined
    }
  }
  const rowLength = (row: number): number => {
    const cached = lengths.get(row)
    if (cached !== undefined) {
      return cached
    }
    const line = buffer.getLine(row)
    let length = terminal.cols
    if (wrapped(row + 1)) {
      length = readReflowedRowCellCount(terminal, metrics, row)
    } else {
      while (length > 0 && !line?.getCell(length - 1)?.getChars()) {
        length -= 1
      }
      const last = length > 0 ? line?.getCell(length - 1) : undefined
      if (last) {
        length += Math.max(1, last.getWidth()) - 1
      }
    }
    lengths.set(row, length)
    return length
  }
  const characterStart = (row: number, column: number): CopyModePosition => {
    const y = Math.max(0, Math.min(buffer.length - 1, row))
    const x = Math.max(0, Math.min(terminal.cols - 1, column))
    return { row: y, column: x > 0 && buffer.getLine(y)?.getCell(x)?.getWidth() === 0 ? x - 1 : x }
  }
  const lineBounds = (row: number): { start: number; end: number } => {
    let start = row,
      end = row
    while (start > 0 && wrapped(start)) {
      start -= 1
    }
    while (end + 1 < buffer.length && wrapped(end + 1)) {
      end += 1
    }
    return { start, end }
  }
  const logicalColumn = (position: CopyModePosition): number => {
    const { start } = lineBounds(position.row)
    let offset = position.column
    for (let row = start; row < position.row; row += 1) {
      offset += rowLength(row)
    }
    return offset
  }
  const atLogicalColumn = (row: number, offset: number): CopyModePosition => {
    const { start, end } = lineBounds(row)
    let y = start,
      remaining = offset
    while (y < end && remaining >= rowLength(y)) {
      remaining -= rowLength(y)
      y += 1
    }
    return characterStart(y, Math.min(remaining, Math.max(0, rowLength(y) - 1)))
  }
  const text = (position: CopyModePosition): string =>
    buffer.getLine(position.row)?.getCell(position.column)?.getChars() ?? ''
  const next = (position: CopyModePosition): CopyModePosition | null => {
    const width = Math.max(
      1,
      buffer.getLine(position.row)?.getCell(position.column)?.getWidth() ?? 1
    )
    if (position.column + width < rowLength(position.row)) {
      return characterStart(position.row, position.column + width)
    }
    return position.row + 1 < buffer.length ? { row: position.row + 1, column: 0 } : null
  }
  const previous = (position: CopyModePosition): CopyModePosition | null => {
    if (position.column > 0) {
      return characterStart(
        position.row,
        Math.min(position.column - 1, Math.max(0, rowLength(position.row) - 1))
      )
    }
    return position.row > 0
      ? characterStart(position.row - 1, Math.max(0, rowLength(position.row - 1) - 1))
      : null
  }
  return {
    characterStart,
    lineBounds,
    logicalColumn,
    atLogicalColumn,
    rowLength,
    text,
    next,
    previous,
    lastRow: buffer.length - 1,
    isBlankLine: (position: CopyModePosition) =>
      rowLength(position.row) === 0 && !wrapped(position.row),
    joins: (a: CopyModePosition, b: CopyModePosition) =>
      a.row === b.row || (b.row === a.row + 1 && wrapped(b.row))
  }
}

export type CopyModeBuffer = ReturnType<typeof createCopyModeBuffer>
