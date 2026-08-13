export const DEFAULT_APP_FONT_WEIGHT = 400
export const APP_FONT_WEIGHT_MIN = 100
export const APP_FONT_WEIGHT_MAX = 900
export const APP_FONT_WEIGHT_STEP = 50

/** Clamp persisted or IPC-provided app font weights into the CSS `font-weight` range. */
export function normalizeAppFontWeight(fontWeight: number | null | undefined): number {
  const numericFontWeight = typeof fontWeight === 'number' ? fontWeight : Number.NaN

  if (!Number.isFinite(numericFontWeight)) {
    return DEFAULT_APP_FONT_WEIGHT
  }

  return Math.min(APP_FONT_WEIGHT_MAX, Math.max(APP_FONT_WEIGHT_MIN, Math.round(numericFontWeight)))
}
