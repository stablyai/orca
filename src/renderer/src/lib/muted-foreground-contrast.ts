import { APP_SURFACE_COLORS, parseCssRgbColor, type RgbaColor } from './terminal-title-contrast'

/** Global --muted-foreground ratio; the light default (#737373 on #fafafa) sits right at 4.5:1. */
export const MUTED_FOREGROUND_MIX_PERCENT = 62
export const MUTED_FOREGROUND_MIN_CONTRAST = 4.5

/** sRGB 0–255 channel → linear-light value per WCAG 2.x. */
function linearizeChannel(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance; alpha is ignored. */
function relativeLuminance({ r, g, b }: RgbaColor): number {
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b)
}

/** WCAG contrast ratio in [1, 21]; order-independent. */
function contrastRatio(a: RgbaColor, b: RgbaColor): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** What `color-mix(in srgb, fg P%, bg)` text looks like on `surface`: CSS Color 4 mixes premultiplied
 *  (so a translucent bg contributes `bg.a` of its weight), and the browser then composites the
 *  still-translucent result over the surface the text sits on. */
function renderMixedText(
  foreground: RgbaColor,
  background: RgbaColor,
  surface: RgbaColor,
  percent: number
): RgbaColor {
  const weight = percent / 100
  const fgWeight = weight * foreground.a
  const bgWeight = (1 - weight) * background.a
  const alpha = fgWeight + bgWeight
  return {
    r: fgWeight * foreground.r + bgWeight * background.r + (1 - alpha) * surface.r,
    g: fgWeight * foreground.g + bgWeight * background.g + (1 - alpha) * surface.g,
    b: fgWeight * foreground.b + bgWeight * background.b + (1 - alpha) * surface.b,
    a: 1
  }
}

/** Why: a fixed 62% mix assumes a near-black/near-white foreground. Low-contrast themes (Solarized
 *  Light's #586e75 on #fdf6e3 is ~5:1) mix down to ~2.4:1 and sidebar captions vanish, so raise the
 *  mix until muted text clears the floor — up to the foreground itself when nothing less will. */
export function resolveMutedForegroundMixPercent(
  background: string,
  foreground: string,
  options: { appSurface?: 'dark' | 'light' } = {}
): number {
  // Why: the text sits on the sidebar as rendered — the (possibly translucent) background over the
  // app surface — while its own transparent part still shows the raw background layer; rate the
  // pixel the browser produces, not the opaque mix.
  const bg = parseCssRgbColor(background)
  const fg = parseCssRgbColor(foreground)
  if (!bg || !fg) {
    return MUTED_FOREGROUND_MIX_PERCENT
  }
  // Unrounded on purpose: the gate sits on a 4.5 boundary, and 8-bit rounding here can flip it.
  const app = APP_SURFACE_COLORS[options.appSurface ?? 'dark']
  const surface: RgbaColor = {
    r: bg.r * bg.a + app.r * (1 - bg.a),
    g: bg.g * bg.a + app.g * (1 - bg.a),
    b: bg.b * bg.a + app.b * (1 - bg.a),
    a: 1
  }
  for (let percent = MUTED_FOREGROUND_MIX_PERCENT; percent < 100; percent += 1) {
    if (
      contrastRatio(renderMixedText(fg, bg, surface, percent), surface) >=
      MUTED_FOREGROUND_MIN_CONTRAST
    ) {
      return percent
    }
  }
  return 100
}
