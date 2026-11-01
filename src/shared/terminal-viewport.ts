export const TERMINAL_VIEWPORT_MIN_COLS = 20
export const TERMINAL_VIEWPORT_MAX_COLS = 1024
export const TERMINAL_VIEWPORT_MIN_ROWS = 8
// Why: matches the terminal.subscribe/send viewport bound; a 120 cap left tall remote panes taller than their PTY (#27425).
export const TERMINAL_VIEWPORT_MAX_ROWS = 500

export function clampTerminalViewport(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.max(
      TERMINAL_VIEWPORT_MIN_COLS,
      Math.min(TERMINAL_VIEWPORT_MAX_COLS, Math.round(cols))
    ),
    rows: Math.max(
      TERMINAL_VIEWPORT_MIN_ROWS,
      Math.min(TERMINAL_VIEWPORT_MAX_ROWS, Math.round(rows))
    )
  }
}
