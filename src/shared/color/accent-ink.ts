import { contrastRatio, hexToRgb, type Rgba } from './rgba-contrast'

// Why these two: the same near-black and near-white as the primary pair in main.css, so a
// default accent keeps the label color it has always had.
export const ACCENT_INK_DARK = '#171717'
export const ACCENT_INK_LIGHT = '#fafafa'

/**
 * The label color for text on a theme's accent fill: whichever of near-black or near-white has
 * the higher contrast on it. Themes don't author this; it follows the accent they set.
 */
export function accentInkHex(accent: Rgba): string {
  const dark = hexToRgb(ACCENT_INK_DARK)
  const light = hexToRgb(ACCENT_INK_LIGHT)
  return contrastRatio(accent, light) > contrastRatio(accent, dark)
    ? ACCENT_INK_LIGHT
    : ACCENT_INK_DARK
}

/** The contrast the chosen ink reaches on the accent, for the validator and its tests. */
export function accentInkContrast(accent: Rgba): number {
  return contrastRatio(accent, hexToRgb(accentInkHex(accent)))
}
