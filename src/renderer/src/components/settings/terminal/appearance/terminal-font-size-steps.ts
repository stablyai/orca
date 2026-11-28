export const TERMINAL_FONT_SIZE_MIN = 10
export const TERMINAL_FONT_SIZE_MAX = 24
export const TERMINAL_FONT_SIZE_STEP = 0.5

export function parseTerminalFontSizeInput(raw: string): number | null {
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value < TERMINAL_FONT_SIZE_MIN || value > TERMINAL_FONT_SIZE_MAX) {
    return null
  }
  return Math.round(value / TERMINAL_FONT_SIZE_STEP) * TERMINAL_FONT_SIZE_STEP
}

export function stepTerminalFontSize(size: number, direction: 1 | -1): number {
  const next = size + direction * TERMINAL_FONT_SIZE_STEP
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, next))
}
