import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_FONT_WEIGHT, normalizeAppFontWeight } from './app-fonts'

describe('normalizeAppFontWeight', () => {
  it('falls back to the default weight when the value is missing', () => {
    expect(normalizeAppFontWeight(undefined)).toBe(DEFAULT_APP_FONT_WEIGHT)
    expect(normalizeAppFontWeight(null)).toBe(DEFAULT_APP_FONT_WEIGHT)
    expect(normalizeAppFontWeight(Number.NaN)).toBe(DEFAULT_APP_FONT_WEIGHT)
  })

  it('clamps weights to the CSS font-weight range', () => {
    expect(normalizeAppFontWeight(10)).toBe(100)
    expect(normalizeAppFontWeight(1200)).toBe(900)
  })

  it('rounds fractional weights from hand-edited profiles', () => {
    expect(normalizeAppFontWeight(437.4)).toBe(437)
    expect(normalizeAppFontWeight(350)).toBe(350)
  })
})
