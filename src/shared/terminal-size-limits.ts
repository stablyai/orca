export const MAX_TERMINAL_COLS = 500
export const MAX_TERMINAL_ROWS = 500

export function terminalSizeAdmissionError(
  cols: unknown,
  rows: unknown,
  field: string,
  options: { allowMissing?: boolean } = {}
): string | null {
  for (const [name, value, max] of [
    ['cols', cols, MAX_TERMINAL_COLS],
    ['rows', rows, MAX_TERMINAL_ROWS]
  ] as const) {
    if (options.allowMissing && value === undefined) {
      continue
    }
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
      return `${field}.${name} must be an integer from 1 through ${max}`
    }
  }
  return null
}

export function isValidTerminalSize(cols: unknown, rows: unknown): boolean {
  return terminalSizeAdmissionError(cols, rows, 'terminal size') === null
}

export function normalizeTerminalSize(
  cols: unknown,
  rows: unknown,
  fallback: { cols: number; rows: number } = { cols: 80, rows: 24 }
): { cols: number; rows: number } {
  return isValidTerminalSize(cols, rows) ? { cols: cols as number, rows: rows as number } : fallback
}
