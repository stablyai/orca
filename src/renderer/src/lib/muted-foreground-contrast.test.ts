import { describe, expect, it } from 'vitest'
import {
  MUTED_FOREGROUND_MIN_CONTRAST,
  MUTED_FOREGROUND_MIX_PERCENT,
  resolveMutedForegroundMixPercent
} from './muted-foreground-contrast'

/** `#rrggbb` → [r, g, b] in 0–255. */
function hexChannels(hex: string): number[] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ]
}

/** sRGB 0–255 channel → linear-light value per WCAG 2.x; independent of the implementation under test. */
function linearize(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance of an [r, g, b] triple. */
function luminance([r, g, b]: number[]): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

/** WCAG contrast ratio from two relative luminances. */
function contrastFromLuminance(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** WCAG contrast of `color-mix(in srgb, fg P%, bg)` over bg, mirroring the browser's sRGB mix. */
function mixedContrast(background: string, foreground: string, percent: number): number {
  const bg = hexChannels(background)
  const fg = hexChannels(foreground)
  const weight = percent / 100
  const mixed = [
    fg[0] * weight + bg[0] * (1 - weight),
    fg[1] * weight + bg[1] * (1 - weight),
    fg[2] * weight + bg[2] * (1 - weight)
  ]
  return contrastFromLuminance(luminance(bg), luminance(mixed))
}

/** Contrast the browser renders for muted text on a translucent sidebar: the sidebar is `bg` at
 *  `bgAlpha` over `surface`; the text is the premultiplied `color-mix(fg P%, bg)` composited over
 *  that sidebar (CSS Color 4 §12.3). Written independently of the implementation under test. */
function renderedContrast(
  background: string,
  bgAlpha: number,
  foreground: string,
  surface: string,
  percent: number
): number {
  const bg = hexChannels(background)
  const fg = hexChannels(foreground)
  const app = hexChannels(surface)
  const sidebar = [
    bg[0] * bgAlpha + app[0] * (1 - bgAlpha),
    bg[1] * bgAlpha + app[1] * (1 - bgAlpha),
    bg[2] * bgAlpha + app[2] * (1 - bgAlpha)
  ]
  const weight = percent / 100
  const textAlpha = weight + (1 - weight) * bgAlpha
  const text = [
    weight * fg[0] + (1 - weight) * bgAlpha * bg[0] + (1 - textAlpha) * sidebar[0],
    weight * fg[1] + (1 - weight) * bgAlpha * bg[1] + (1 - textAlpha) * sidebar[1],
    weight * fg[2] + (1 - weight) * bgAlpha * bg[2] + (1 - textAlpha) * sidebar[2]
  ]
  return contrastFromLuminance(luminance(sidebar), luminance(text))
}

describe('resolveMutedForegroundMixPercent', () => {
  it('keeps the global mix ratio for a high-contrast pair', () => {
    expect(resolveMutedForegroundMixPercent('#101820', '#f0f4f8')).toBe(
      MUTED_FOREGROUND_MIX_PERCENT
    )
    expect(resolveMutedForegroundMixPercent('#fafafa', '#0a0a0a')).toBe(
      MUTED_FOREGROUND_MIX_PERCENT
    )
  })

  it('raises the mix until muted text clears the contrast floor on a low-contrast light theme', () => {
    // Solarized Light: fg #586e75 is ~5:1, so the fixed 62% mix lands at ~2.4:1 (#16999).
    const percent = resolveMutedForegroundMixPercent('#fdf6e3', '#586e75')
    expect(percent).toBeGreaterThan(MUTED_FOREGROUND_MIX_PERCENT)
    expect(percent).toBeLessThan(100)
    expect(mixedContrast('#fdf6e3', '#586e75', percent)).toBeGreaterThanOrEqual(
      MUTED_FOREGROUND_MIN_CONTRAST
    )
    expect(mixedContrast('#fdf6e3', '#586e75', percent - 1)).toBeLessThan(
      MUTED_FOREGROUND_MIN_CONTRAST
    )
  })

  it('raises the mix on a low-contrast dark theme too', () => {
    const percent = resolveMutedForegroundMixPercent('#002b36', '#839496')
    expect(percent).toBeGreaterThan(MUTED_FOREGROUND_MIX_PERCENT)
    expect(mixedContrast('#002b36', '#839496', percent)).toBeGreaterThanOrEqual(
      MUTED_FOREGROUND_MIN_CONTRAST
    )
  })

  it('falls back to the foreground itself when even that misses the floor', () => {
    expect(resolveMutedForegroundMixPercent('#fdf6e3', '#93a1a1')).toBe(100)
  })

  it('treats a fully opaque rgba() background like its hex form', () => {
    expect(resolveMutedForegroundMixPercent('rgba(253, 246, 227, 1)', '#586e75')).toBe(
      resolveMutedForegroundMixPercent('#fdf6e3', '#586e75')
    )
  })

  it('gates a translucent background on the pixel the browser renders, per app surface', () => {
    const translucent = 'rgba(253, 246, 227, 0.5)'
    // 50% Solarized Light over the light surface (#ffffff) / the dark surface (#0a0a0a).
    const overLight = resolveMutedForegroundMixPercent(translucent, '#586e75', {
      appSurface: 'light'
    })
    const overDark = resolveMutedForegroundMixPercent(translucent, '#586e75', {
      appSurface: 'dark'
    })
    expect(
      renderedContrast('#fdf6e3', 0.5, '#586e75', '#ffffff', overLight)
    ).toBeGreaterThanOrEqual(MUTED_FOREGROUND_MIN_CONTRAST)
    expect(renderedContrast('#fdf6e3', 0.5, '#586e75', '#ffffff', overLight - 1)).toBeLessThan(
      MUTED_FOREGROUND_MIN_CONTRAST
    )
    // Over the dark surface the sidebar turns mid-gray (~#848077), which #586e75 cannot clear even
    // undiluted (~1.4:1), so the gate falls back to the foreground itself.
    expect(overDark).toBe(100)
    expect(renderedContrast('#fdf6e3', 0.5, '#586e75', '#0a0a0a', 100)).toBeLessThan(
      MUTED_FOREGROUND_MIN_CONTRAST
    )
  })

  it('does not stop short because the text still shows the raw background layer through it', () => {
    // Solarized Dark at 50% on the dark surface: an opaque mix against the composited sidebar
    // would pass at a lower percent whose rendered pixel is still below the floor.
    const percent = resolveMutedForegroundMixPercent('rgba(0, 43, 54, 0.5)', '#839496', {
      appSurface: 'dark'
    })
    expect(percent).toBeLessThan(100)
    expect(renderedContrast('#002b36', 0.5, '#839496', '#0a0a0a', percent)).toBeGreaterThanOrEqual(
      MUTED_FOREGROUND_MIN_CONTRAST
    )
    expect(renderedContrast('#002b36', 0.5, '#839496', '#0a0a0a', percent - 1)).toBeLessThan(
      MUTED_FOREGROUND_MIN_CONTRAST
    )
  })

  it('accounts for a translucent foreground', () => {
    // Half-transparent black on white can never reach 4.5:1 (its 100% is mid-gray, ~4:1).
    expect(resolveMutedForegroundMixPercent('#ffffff', 'rgba(0, 0, 0, 0.5)')).toBe(100)
    expect(resolveMutedForegroundMixPercent('#ffffff', 'rgba(0, 0, 0, 0.8)')).toBeGreaterThan(
      resolveMutedForegroundMixPercent('#ffffff', '#000000')
    )
  })

  it('keeps the global ratio for colors it cannot parse', () => {
    expect(resolveMutedForegroundMixPercent('var(--background)', 'var(--foreground)')).toBe(
      MUTED_FOREGROUND_MIX_PERCENT
    )
  })
})
