import type { Terminal } from '@xterm/xterm'

/** Inverse of terminal-mouse-buffer-position.ts's DOM→cell math: cell→DOM pixels. */
export function cellToPixelPosition(
  terminal: Terminal,
  row: number,
  col: number
): { top: number; left: number } | null {
  const screenElement = terminal.element?.querySelector('.xterm-screen')
  if (!screenElement) {
    return null
  }
  const rect = (screenElement as HTMLElement).getBoundingClientRect()
  const cellWidth = rect.width / terminal.cols
  const cellHeight = rect.height / terminal.rows
  // Why: row is the absolute scrollback row (buffer.baseY + cursorY), which
  // grows unboundedly — subtract viewportY to get the on-screen row.
  const viewportRow = row - terminal.buffer.active.viewportY
  return {
    top: rect.top + viewportRow * cellHeight,
    left: rect.left + col * cellWidth
  }
}
