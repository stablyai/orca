import { describe, expect, it } from 'vitest'
import {
  DARK_CHROME_BACKGROUND,
  LIGHT_CHROME_BACKGROUND,
  PURE_BLACK_CHROME_BACKGROUND,
  isPureBlackVariant,
  resolveChromeBackgroundColor,
  resolveDarkAppearanceVariant
} from './dark-appearance-variant'

describe('resolveDarkAppearanceVariant', () => {
  it('keeps profiles saved before the variant on the gray dark theme', () => {
    expect(resolveDarkAppearanceVariant(undefined)).toBe('default')
    expect(resolveDarkAppearanceVariant(null)).toBe('default')
  })

  it('honors an explicit pure-black choice', () => {
    expect(resolveDarkAppearanceVariant('pure-black')).toBe('pure-black')
    expect(isPureBlackVariant('pure-black')).toBe(true)
  })
})

describe('resolveChromeBackgroundColor', () => {
  it('paints the pre-renderer window black so launch does not flash gray', () => {
    expect(resolveChromeBackgroundColor({ dark: true, variant: 'pure-black' })).toBe(
      PURE_BLACK_CHROME_BACKGROUND
    )
  })

  it('leaves the default dark and light fills untouched', () => {
    expect(resolveChromeBackgroundColor({ dark: true, variant: 'default' })).toBe(
      DARK_CHROME_BACKGROUND
    )
    expect(resolveChromeBackgroundColor({ dark: true })).toBe(DARK_CHROME_BACKGROUND)
    // The variant never applies in light mode, even when persisted.
    expect(resolveChromeBackgroundColor({ dark: false, variant: 'pure-black' })).toBe(
      LIGHT_CHROME_BACKGROUND
    )
  })
})
