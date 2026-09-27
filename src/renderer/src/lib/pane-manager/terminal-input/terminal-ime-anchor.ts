import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm'

export type TerminalImeAnchor = {
  row: number
  column: number
}

/**
 * The caret an app draws itself after hiding the terminal cursor (DECTCEM off): a lone
 * inverse-video cell. `null` when the cursor is shown, since that is where the app takes input.
 *
 * Why this shape: the captured transcripts (src/main/runtime/__fixtures__/*-ime-*.txt) show
 * cursor-agent hiding the cursor, parking it at column 0 below its input box and painting the
 * insertion point as one SGR 7 cell, while Claude Code, Codex and Grok keep the real cursor shown
 * on the caret. A run of inverse cells is a highlight (a selected menu row), never a caret.
 */
export function resolveAppDrawnImeCaret(args: {
  buffer: IBuffer
  rows: number
  cols: number
  cursorVisible: boolean
  /** A previously resolved caret, rechecked in one cell read before rescanning the screen. */
  knownCaret?: TerminalImeAnchor
}): TerminalImeAnchor | null {
  if (args.cursorVisible) {
    return null
  }
  const { buffer, knownCaret } = args
  // Reused for every read: a full-screen scan must not allocate per cell.
  const work = buffer.getNullCell()
  if (knownCaret && isLoneInverseAt(buffer, knownCaret, args.cols, work)) {
    return knownCaret
  }
  let best: TerminalImeAnchor | null = null
  for (let row = 0; row < args.rows; row++) {
    const line = buffer.getLine(buffer.baseY + row)
    if (!line) {
      continue
    }
    const cols = Math.min(line.length, args.cols)
    let previousInverse = false
    for (let column = 0; column < cols; column++) {
      const cell = line.getCell(column, work)
      if (!cell || cell.getWidth() === 0) {
        continue
      }
      const inverse = isInverse(cell)
      const width = Math.max(cell.getWidth(), 1)
      if (inverse && !previousInverse && !isInverseAt(line, column + width, cols, work)) {
        best = nearerToCursor(best, { row, column }, buffer.cursorY)
      }
      previousInverse = inverse
    }
  }
  return best
}

function isLoneInverseAt(
  buffer: IBuffer,
  caret: TerminalImeAnchor,
  maxCols: number,
  work: IBufferCell
): boolean {
  const line = buffer.getLine(buffer.baseY + caret.row)
  if (!line) {
    return false
  }
  const cols = Math.min(line.length, maxCols)
  const cell = caret.column < cols ? line.getCell(caret.column, work) : undefined
  if (!cell || cell.getWidth() === 0 || !isInverse(cell)) {
    return false
  }
  const width = Math.max(cell.getWidth(), 1)
  return (
    !isInverseAt(line, caret.column + width, cols, work) &&
    !isInverseBefore(line, caret.column, cols, work)
  )
}

/** Whether the nearest non-continuation cell left of `column` is inverse. */
function isInverseBefore(
  line: IBufferLine,
  column: number,
  cols: number,
  work: IBufferCell
): boolean {
  for (let previous = column - 1; previous >= 0; previous--) {
    const cell = previous < cols ? line.getCell(previous, work) : undefined
    if (!cell) {
      return false
    }
    if (cell.getWidth() !== 0) {
      return isInverse(cell)
    }
  }
  return false
}

function isInverse(cell: IBufferCell): boolean {
  return cell.isInverse() !== 0
}

function isInverseAt(line: IBufferLine, column: number, cols: number, work: IBufferCell): boolean {
  const cell = column < cols ? line.getCell(column, work) : undefined
  return cell !== undefined && isInverse(cell)
}

function nearerToCursor(
  current: TerminalImeAnchor | null,
  candidate: TerminalImeAnchor,
  cursorRow: number
): TerminalImeAnchor {
  if (!current) {
    return candidate
  }
  return Math.abs(candidate.row - cursorRow) <= Math.abs(current.row - cursorRow)
    ? candidate
    : current
}
