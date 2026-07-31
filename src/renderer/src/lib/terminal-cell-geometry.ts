import type { Terminal } from '@xterm/xterm'

export type TerminalCellGeometry = {
  cellWidth: number
  cellHeight: number
  /** Top-left of xterm's rendered grid, relative to `container`'s border box. */
  originLeft: number
  originTop: number
}

/**
 * Real per-cell pixel size and grid origin, read from xterm's rendered
 * `.xterm-screen` element (xterm sizes it to cols*cellWidth x rows*cellHeight)
 * instead of approximating cell size from container.clientWidth/cols. That
 * approximation ignores the container's own padding/margin, scrollbars, and
 * sub-pixel cell sizes, which is why remote cursors/selections can drift from
 * where the user actually dragged. `.xterm-screen` is an xterm DOM
 * implementation detail (not a documented public API) — mirrors the same
 * trade-off already made in pane-lifecycle.ts's IME anchor fix — so a future
 * xterm version could rename/remove it; callers must keep a
 * container/cols fallback (approximateTerminalCellGeometry) for that case.
 */
export function resolveTerminalCellGeometry(
  terminal: Terminal,
  container: HTMLElement
): TerminalCellGeometry | null {
  const screenElement = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screenElement) {
    return null
  }
  const containerRect = container.getBoundingClientRect()
  const screenRect = screenElement.getBoundingClientRect()
  const cellWidth = screenRect.width / Math.max(1, terminal.cols)
  const cellHeight = screenRect.height / Math.max(1, terminal.rows)
  if (!(cellWidth > 0) || !(cellHeight > 0)) {
    return null
  }
  return {
    cellWidth,
    cellHeight,
    originLeft: screenRect.left - containerRect.left + container.scrollLeft,
    originTop: screenRect.top - containerRect.top + container.scrollTop
  }
}

/** Best-effort fallback for when `.xterm-screen` isn't measurable yet (e.g.
 *  before xterm's first paint) — same approximation this module replaces as
 *  the primary source, kept only as a last resort. Assumes no container
 *  padding/offset, which is the source of the drift this module fixes. */
export function approximateTerminalCellGeometry(
  container: HTMLElement,
  cols: number,
  rows: number
): TerminalCellGeometry {
  return {
    cellWidth: container.clientWidth / Math.max(1, cols),
    cellHeight: container.clientHeight / Math.max(1, rows),
    originLeft: 0,
    originTop: 0
  }
}

/** Pure coordinate transform: a client-space point (e.g. from a MouseEvent) to
 *  the terminal cell it falls in, clamped to the current grid bounds. */
export function clientPointToTerminalCell(
  clientX: number,
  clientY: number,
  containerRect: { left: number; top: number },
  geometry: TerminalCellGeometry,
  cols: number,
  rows: number
): { col: number; row: number } {
  const localX = clientX - containerRect.left - geometry.originLeft
  const localY = clientY - containerRect.top - geometry.originTop
  const col = Math.floor(localX / geometry.cellWidth)
  const row = Math.floor(localY / geometry.cellHeight)
  return {
    col: Math.max(0, Math.min(cols - 1, col)),
    row: Math.max(0, Math.min(rows - 1, row))
  }
}
