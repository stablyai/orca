import { readRgbChannels } from './xlsx-color'

// Why: these are not theme colours and no token covers them — they are the two
// maximal-contrast inks over an arbitrary colour that came out of a data file.
// A workbook fill is chosen by its author against Excel's white sheet, so on a
// dark theme the app's own foreground would frequently be unreadable on top of
// it; the ink has to follow the fill, not the theme.
const INK_ON_LIGHT_FILL = '#000000'
const INK_ON_DARK_FILL = '#ffffff'
// The WCAG AA thresholds: 4.5:1 for body text, 3:1 for large text. Applying the
// body threshold to a heading discards the author's accent colour for no reason —
// an 18pt bold title in a brand orange is legible on white and is exactly what
// both Excel and Sheets show.
const MIN_READABLE_CONTRAST_RATIO = 4.5
const MIN_READABLE_LARGE_TEXT_CONTRAST_RATIO = 3
// WCAG's definition of large: 18pt, or 14pt when bold.
const LARGE_TEXT_POINTS = 18
const LARGE_BOLD_TEXT_POINTS = 14

export type CellTextWeight = { sizePt?: number; bold?: boolean }

export function isLargeCellText({ sizePt, bold }: CellTextWeight): boolean {
  if (sizePt === undefined) {
    return false
  }
  return sizePt >= LARGE_TEXT_POINTS || (bold === true && sizePt >= LARGE_BOLD_TEXT_POINTS)
}

/**
 * Picks a readable text colour for a cell that carries a background fill.
 *
 * The workbook's own font colour wins when it is legible on that fill — that is
 * the author's intent, and it is usually the white-on-dark-header case. When it
 * is not legible, or absent, the ink falls back to whichever of black or white
 * contrasts more.
 */
export function pickReadableCellTextColor(
  backgroundColor: string,
  declaredTextColor?: string | null,
  textWeight: CellTextWeight = {}
): string {
  const minimumRatio = isLargeCellText(textWeight)
    ? MIN_READABLE_LARGE_TEXT_CONTRAST_RATIO
    : MIN_READABLE_CONTRAST_RATIO
  if (
    declaredTextColor !== undefined &&
    declaredTextColor !== null &&
    getContrastRatio(declaredTextColor, backgroundColor) >= minimumRatio
  ) {
    return declaredTextColor
  }
  return getContrastRatio(INK_ON_LIGHT_FILL, backgroundColor) >=
    getContrastRatio(INK_ON_DARK_FILL, backgroundColor)
    ? INK_ON_LIGHT_FILL
    : INK_ON_DARK_FILL
}

/** WCAG contrast ratio, from 1 (identical) to 21 (black on white). */
export function getContrastRatio(color: string, otherColor: string): number {
  const luminance = getRelativeLuminance(color)
  const otherLuminance = getRelativeLuminance(otherColor)
  if (luminance === null || otherLuminance === null) {
    return 1
  }
  const lighter = Math.max(luminance, otherLuminance)
  const darker = Math.min(luminance, otherLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

/** WCAG relative luminance, or null when the colour cannot be read. */
export function getRelativeLuminance(color: string): number | null {
  const rgb = readRgbChannels(color)
  if (rgb === null) {
    return null
  }
  return (
    0.2126 * toLinearChannel(rgb.red) +
    0.7152 * toLinearChannel(rgb.green) +
    0.0722 * toLinearChannel(rgb.blue)
  )
}

function toLinearChannel(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}
