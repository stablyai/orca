/**
 * The CSS colour steps a terminal pane's theme goes through, shared so main's settings seed and
 * the renderer's view-attribute publisher stay byte-identical to what a visible xterm reports.
 */
import type { TerminalViewRgb } from './terminal-view-attributes'

export type ParsedTerminalCssColor = {
  rgb: TerminalViewRgb
  /** 0-255, the precision xterm stores (rgba byte) — blend parity needs it. */
  alpha: number
}

/** A non-hex input yields NaN channels, which parseTerminalCssColor then rejects. */
export function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.replace('#', '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Mirror of xterm's channels.toRgba packing then color.toColorRGB: an out-of-range rgb() channel
// wraps into its neighbours exactly as a visible pane's OSC reply reports it.
function packLikeXterm(r: number, g: number, b: number, a: number): ParsedTerminalCssColor {
  const rgba = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0
  return {
    rgb: [(rgba >>> 24) & 0xff, (rgba >>> 16) & 0xff, (rgba >>> 8) & 0xff],
    alpha: rgba & 0xff
  }
}

/** Mirror of xterm's css.toColor fast paths (#rgb[a], #rrggbb[aa], rgb(),
 *  rgba()) — every format first-party inputs produce (builtin themes and the
 *  ghostty import are hex-validated; composeActiveTerminalTheme only adds the
 *  rgba() form this regex accepts). Known divergence boundary: the renderer's
 *  css.toColor also resolves named/modern CSS via a canvas litmus, so a
 *  hand-edited settings value like `background: 'darkslategray'` renders on
 *  a visible pane but falls back to the slot default in the hidden reply. */
export function parseTerminalCssColor(css: string): ParsedTerminalCssColor | null {
  if (/^#[\da-f]{3,8}$/i.test(css)) {
    switch (css.length) {
      case 4:
        return {
          rgb: [
            Number.parseInt(css.slice(1, 2).repeat(2), 16),
            Number.parseInt(css.slice(2, 3).repeat(2), 16),
            Number.parseInt(css.slice(3, 4).repeat(2), 16)
          ],
          alpha: 0xff
        }
      case 5:
        return {
          rgb: [
            Number.parseInt(css.slice(1, 2).repeat(2), 16),
            Number.parseInt(css.slice(2, 3).repeat(2), 16),
            Number.parseInt(css.slice(3, 4).repeat(2), 16)
          ],
          alpha: Number.parseInt(css.slice(4, 5).repeat(2), 16)
        }
      case 7:
        return {
          rgb: [
            Number.parseInt(css.slice(1, 3), 16),
            Number.parseInt(css.slice(3, 5), 16),
            Number.parseInt(css.slice(5, 7), 16)
          ],
          alpha: 0xff
        }
      case 9:
        return {
          rgb: [
            Number.parseInt(css.slice(1, 3), 16),
            Number.parseInt(css.slice(3, 5), 16),
            Number.parseInt(css.slice(5, 7), 16)
          ],
          alpha: Number.parseInt(css.slice(7, 9), 16)
        }
      default:
        return null
    }
  }
  const rgbaMatch = css.match(
    /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(,\s*(0|1|\d?\.(\d+))\s*)?\)/
  )
  if (rgbaMatch) {
    return packLikeXterm(
      Number.parseInt(rgbaMatch[1], 10),
      Number.parseInt(rgbaMatch[2], 10),
      Number.parseInt(rgbaMatch[3], 10),
      Math.round((rgbaMatch[5] === undefined ? 1 : Number.parseFloat(rgbaMatch[5])) * 0xff)
    )
  }
  return null
}
