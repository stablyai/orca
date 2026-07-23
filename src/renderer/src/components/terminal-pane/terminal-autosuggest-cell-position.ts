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
  // Why: the tracked row can scroll out of view (user scrolled scrollback) —
  // without this the ghost text would render above/below the terminal element
  // (position: fixed, unclipped) instead of disappearing.
  if (viewportRow < 0 || viewportRow >= terminal.rows) {
    return null
  }
  return {
    top: rect.top + viewportRow * cellHeight,
    left: rect.left + col * cellWidth
  }
}
