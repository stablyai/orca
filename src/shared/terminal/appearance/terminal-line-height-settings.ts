export const MIN_TERMINAL_LINE_HEIGHT = 1
export const MAX_TERMINAL_LINE_HEIGHT = 3

export function normalizeTerminalLineHeight(value: unknown): number {
  // Persisted/user-edited values bypass UI bounds; xterm throws below one.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MIN_TERMINAL_LINE_HEIGHT
  }
  return Math.min(MAX_TERMINAL_LINE_HEIGHT, Math.max(MIN_TERMINAL_LINE_HEIGHT, value))
}
