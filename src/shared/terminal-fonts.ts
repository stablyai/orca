export const DEFAULT_TERMINAL_FONT_WEIGHT = 500
export const TERMINAL_FONT_WEIGHT_MIN = 100
export const TERMINAL_FONT_WEIGHT_MAX = 900
export const TERMINAL_FONT_WEIGHT_STEP = 100
export const DEFAULT_TERMINAL_FONT_WEIGHT_BOLD = 700

export function normalizeTerminalFontWeight(fontWeight: number | null | undefined): number {
  const numericFontWeight = typeof fontWeight === 'number' ? fontWeight : NaN

  if (!Number.isFinite(numericFontWeight)) {
    return DEFAULT_TERMINAL_FONT_WEIGHT
  }

  return Math.min(
    TERMINAL_FONT_WEIGHT_MAX,
    Math.max(TERMINAL_FONT_WEIGHT_MIN, Math.round(numericFontWeight))
  )
}

export function resolveTerminalFontWeights(fontWeight: number | null | undefined): {
  fontWeight: number
  fontWeightBold: number
} {
  const normalizedFontWeight = normalizeTerminalFontWeight(fontWeight)

  return {
    fontWeight: normalizedFontWeight,
    fontWeightBold: Math.min(
      TERMINAL_FONT_WEIGHT_MAX,
      Math.max(DEFAULT_TERMINAL_FONT_WEIGHT_BOLD, normalizedFontWeight + 200)
    )
  }
}
