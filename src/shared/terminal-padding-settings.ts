const MIN_TERMINAL_PADDING = 0
const MAX_TERMINAL_PADDING = 512

export function normalizeTerminalPadding(value: number): number {
  return Math.min(MAX_TERMINAL_PADDING, Math.max(MIN_TERMINAL_PADDING, Math.round(value)))
}
