// Mirrors FitAddon.proposeDimensions in @xterm/addon-fit 0.12.0-beta.301 (xterm 6.1.0-beta.304).
const MINIMUM_COLS = 2
const MINIMUM_ROWS = 1
const DEFAULT_SCROLL_BAR_WIDTH = 14

export type TerminalFitMetrics = {
  cell: { width: number; height: number }
  padding: { top: number; right: number; bottom: number; left: number }
  scrollback: number | undefined
  scrollbar: { showScrollbar?: boolean; width?: number } | undefined
}

/** The grid a terminal would fit to if its xterm host element had this box. */
export function terminalGridSizeForBox(
  box: { width: number; height: number },
  metrics: TerminalFitMetrics
): { cols: number; rows: number } {
  const { cell, padding, scrollback, scrollbar } = metrics
  const scrollbarWidth =
    scrollback === 0 || !(scrollbar?.showScrollbar ?? true)
      ? 0
      : (scrollbar?.width ?? DEFAULT_SCROLL_BAR_WIDTH)
  // FitAddon reads the host's computed width/height with parseInt, which truncates.
  const width = Math.max(0, Math.trunc(box.width)) - padding.left - padding.right - scrollbarWidth
  const height = Math.max(0, Math.trunc(box.height)) - padding.top - padding.bottom
  return {
    cols: Math.max(MINIMUM_COLS, Math.floor(width / cell.width)),
    rows: Math.max(MINIMUM_ROWS, Math.floor(height / cell.height))
  }
}
