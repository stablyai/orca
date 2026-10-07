// Why separate from live admission: existing recovery was written through a 1,000-column viewport contract.
const MAX_TERMINAL_HISTORY_COLS = 1_000
const MAX_TERMINAL_HISTORY_ROWS = 500

export function isValidTerminalHistorySize(cols: unknown, rows: unknown): boolean {
  return (
    typeof cols === 'number' &&
    Number.isSafeInteger(cols) &&
    cols >= 1 &&
    cols <= MAX_TERMINAL_HISTORY_COLS &&
    typeof rows === 'number' &&
    Number.isSafeInteger(rows) &&
    rows >= 1 &&
    rows <= MAX_TERMINAL_HISTORY_ROWS
  )
}
