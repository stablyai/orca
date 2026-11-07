import type { Terminal } from '@xterm/xterm'
import {
  createCopyModeBuffer,
  type CopyModeBuffer,
  type CopyModePosition
} from './terminal-copy-mode-buffer'
import type { CopyModeSelection } from './terminal-copy-mode-selection'

function capturePosition(terminal: Terminal, buffer: CopyModeBuffer, position: CopyModePosition) {
  const { start } = buffer.lineBounds(position.row)
  return {
    marker: terminal.registerMarker(
      start - terminal.buffer.active.baseY - terminal.buffer.active.cursorY
    ),
    row: start,
    offset: buffer.logicalColumn(position)
  }
}

export function resizeCopyModeSelection(
  terminal: Terminal,
  state: CopyModeSelection,
  dimensions: { cols: number; rows: number }
): boolean {
  if (terminal.cols === dimensions.cols && terminal.rows === dimensions.rows) {
    return false
  }
  const cursor = capturePosition(terminal, state.buffer, state.cursor)
  const anchor = state.anchor ? capturePosition(terminal, state.buffer, state.anchor) : null
  const viewport = capturePosition(terminal, state.buffer, {
    row: terminal.buffer.active.viewportY,
    column: 0
  })
  const positions = [cursor, anchor, viewport]
  try {
    if (dimensions.cols < terminal.cols) {
      // Rewrapping must not evict frozen history when it creates more physical rows.
      const rows = terminal.buffer.active.length
      terminal.options.scrollback = Math.max(
        terminal.options.scrollback ?? 0,
        rows + Math.ceil((rows * terminal.cols) / dimensions.cols)
      )
    }
    terminal.resize(dimensions.cols, dimensions.rows)
    const buffer = createCopyModeBuffer(terminal)
    const restore = (position: ReturnType<typeof capturePosition>): CopyModePosition => {
      const row =
        position.marker && !position.marker.isDisposed ? position.marker.line : position.row
      return buffer.atLogicalColumn(Math.max(0, Math.min(buffer.lastRow, row)), position.offset)
    }
    state.buffer = buffer
    state.cursor = restore(cursor)
    state.anchor = anchor ? restore(anchor) : null
    terminal.scrollToLine(restore(viewport).row)
    return true
  } finally {
    for (const position of positions) {
      position?.marker?.dispose()
    }
  }
}
