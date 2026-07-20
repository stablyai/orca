import type { Terminal } from '@xterm/xterm'

type ReflowLineReader = {
  getCellMetrics: (lineY: number, column: number) => { code: number; width: number } | undefined
  isWrapped: (lineY: number) => boolean
}

type TerminalWithInternalBufferLines = Terminal & {
  _core?: {
    _bufferService?: {
      buffer?: {
        lines?: {
          get: (lineY: number) =>
            | {
                getCodePoint: (column: number) => number
                getWidth: (column: number) => number
                isWrapped: boolean
                length: number
              }
            | undefined
        }
      }
    }
  }
}

export function captureLogicalLineAnchor(
  terminal: Terminal,
  viewportY: number
): { cellOffset: number; lineY: number } | undefined {
  const buf = terminal.buffer.active
  if (typeof buf.getLine !== 'function' || shouldKeepPhysicalResizeAnchor(terminal)) {
    return undefined
  }
  const lines = createReflowLineReader(terminal)
  let lineY = viewportY
  while (lineY > 0 && lines.isWrapped(lineY)) {
    lineY -= 1
  }
  const cursorLineY = buf.baseY + buf.cursorY
  if (terminal.options?.reflowCursorLine !== true && lineContainsLine(lines, lineY, cursorLineY)) {
    return undefined
  }
  let cellOffset = 0
  for (let currentLineY = lineY; currentLineY < viewportY; currentLineY += 1) {
    cellOffset += readReflowedRowCellCount(terminal, lines, currentLineY)
  }
  return { cellOffset, lineY }
}

function shouldKeepPhysicalResizeAnchor(terminal: Terminal): boolean {
  const windowsPty = terminal.options?.windowsPty
  if (!windowsPty?.buildNumber) {
    return false
  }
  // Why: xterm disables reflow only when an explicit legacy build is present;
  // Orca's backend-only fallback for an unknown Windows build still reflows.
  return windowsPty.backend !== 'conpty' || windowsPty.buildNumber < 21376
}

function lineContainsLine(
  lines: ReflowLineReader,
  logicalStartY: number,
  targetY: number
): boolean {
  if (targetY < logicalStartY) {
    return false
  }
  for (let lineY = logicalStartY + 1; lineY <= targetY; lineY += 1) {
    if (!lines.isWrapped(lineY)) {
      return false
    }
  }
  return true
}

export function resolveLogicalCellOffsetLine(
  terminal: Terminal,
  logicalStartY: number,
  cellOffset: number
): number {
  const buf = terminal.buffer.active
  const lines = createReflowLineReader(terminal)
  let lineY = logicalStartY
  let remainingCells = cellOffset
  while (lineY < buf.baseY && lines.isWrapped(lineY + 1)) {
    const rowCells = readReflowedRowCellCount(terminal, lines, lineY)
    if (remainingCells < rowCells) {
      break
    }
    remainingCells -= rowCells
    lineY += 1
  }
  return lineY
}

function readReflowedRowCellCount(
  terminal: Terminal,
  lines: ReflowLineReader,
  lineY: number
): number {
  const cols = Math.max(terminal.cols, 1)
  const lastCell = lines.getCellMetrics(lineY, cols - 1)
  const nextFirstCell = lines.getCellMetrics(lineY + 1, 0)
  // Why: xterm wraps a width-2 glyph one cell early when only the last column
  // remains. That placeholder is not part of the logical cell offset.
  return lastCell?.code === 0 && lastCell.width === 1 && nextFirstCell?.width === 2
    ? cols - 1
    : cols
}

function createReflowLineReader(terminal: Terminal): ReflowLineReader {
  const internalLines = (terminal as TerminalWithInternalBufferLines)._core?._bufferService?.buffer
    ?.lines
  if (internalLines) {
    // Why: public getLine/getCell allocate wrapper objects per row/cell. The
    // pinned xterm core exposes the same active lines without resize-path GC.
    return {
      isWrapped: (lineY) => internalLines.get(lineY)?.isWrapped ?? false,
      getCellMetrics: (lineY, column) => {
        const line = internalLines.get(lineY)
        if (!line || column < 0 || column >= line.length) {
          return undefined
        }
        return { code: line.getCodePoint(column), width: line.getWidth(column) }
      }
    }
  }
  const buffer = terminal.buffer.active
  return {
    isWrapped: (lineY) => buffer.getLine(lineY)?.isWrapped ?? false,
    getCellMetrics: (lineY, column) => {
      const cell = buffer.getLine(lineY)?.getCell(column)
      return cell ? { code: cell.getCode(), width: cell.getWidth() } : undefined
    }
  }
}
