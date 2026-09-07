export const DEFAULT_TERMINAL_FONT_WEIGHT = 500
export const TERMINAL_FONT_WEIGHT_MIN = 100
export const TERMINAL_FONT_WEIGHT_MAX = 900
export const TERMINAL_FONT_WEIGHT_STEP = 100
export const DEFAULT_TERMINAL_FONT_WEIGHT_BOLD = 700

function normalizeWeight(fontWeight: number | null | undefined, fallback: number): number {
  const numericFontWeight = typeof fontWeight === 'number' ? fontWeight : Number.NaN

  if (!Number.isFinite(numericFontWeight)) {
    return fallback
  }

  return Math.min(
    TERMINAL_FONT_WEIGHT_MAX,
    Math.max(TERMINAL_FONT_WEIGHT_MIN, Math.round(numericFontWeight))
  )
}

export function normalizeTerminalFontWeight(fontWeight: number | null | undefined): number {
  return normalizeWeight(fontWeight, DEFAULT_TERMINAL_FONT_WEIGHT)
}

export function normalizeTerminalFontWeightBold(fontWeight: number | null | undefined): number {
  return normalizeWeight(fontWeight, DEFAULT_TERMINAL_FONT_WEIGHT_BOLD)
}

// Numeric weight gaps do not guarantee distinct font faces, so bold stays independently configurable.
export function resolveTerminalFontWeights(
  fontWeight: number | null | undefined,
  fontWeightBold: number | null | undefined
): {
  fontWeight: number
  fontWeightBold: number
} {
  return {
    fontWeight: normalizeTerminalFontWeight(fontWeight),
    fontWeightBold: normalizeTerminalFontWeightBold(fontWeightBold)
  }
}
