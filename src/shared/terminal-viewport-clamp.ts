export const TERMINAL_VIEWPORT_MIN_COLS = 20
// Why: 240 left a blank pad on wide monitors; keep a ceiling so a bogus resize cannot grow unbounded.
export const TERMINAL_VIEWPORT_MAX_COLS = 1024
export const TERMINAL_VIEWPORT_MIN_ROWS = 8
export const TERMINAL_VIEWPORT_MAX_ROWS = 120

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
