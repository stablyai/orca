import { describe, expect, it } from 'vitest'
import { getEastAsianDisplayWidth, padEndToEastAsianDisplayWidth } from './east-asian-display-width'

// Why: built from code points rather than written as literals — a raw control
// byte in the source makes git treat this file as binary and hides the diff.
const VARIATION_SELECTOR_16 = String.fromCodePoint(0xfe0f)
const COMBINING_ACUTE = String.fromCodePoint(0x0301)
const UNIT_SEPARATOR = String.fromCodePoint(0x001f)
const ROCKET = String.fromCodePoint(0x1f680)

describe('getEastAsianDisplayWidth', () => {
  it('counts ASCII as one column each', () => {
    expect(getEastAsianDisplayWidth('Alice')).toBe(5)
    expect(getEastAsianDisplayWidth('')).toBe(0)
  })

  it('counts Hangul syllables as two columns', () => {
    // Three syllables: 3 UTF-16 code units, 6 terminal columns.
    expect('배현우'.length).toBe(3)
    expect(getEastAsianDisplayWidth('배현우')).toBe(6)
  })

  it('counts CJK and kana as two columns', () => {
    expect(getEastAsianDisplayWidth('東京')).toBe(4)
    expect(getEastAsianDisplayWidth('ひらがな')).toBe(8)
    expect(getEastAsianDisplayWidth('中文')).toBe(4)
  })

  it('counts fullwidth forms as two columns', () => {
    expect(getEastAsianDisplayWidth('ＡＢ')).toBe(4)
  })

  it('measures a mixed string by columns, not code units', () => {
    expect(getEastAsianDisplayWidth('배포 v2')).toBe(4 + 1 + 2)
  })

  it('measures an astral character once rather than per surrogate half', () => {
    expect(ROCKET.length).toBe(2)
    expect(getEastAsianDisplayWidth(ROCKET)).toBe(2)
  })

  it('ignores combining marks and variation selectors', () => {
    expect(getEastAsianDisplayWidth(`e${COMBINING_ACUTE}`)).toBe(1)
    expect(getEastAsianDisplayWidth(VARIATION_SELECTOR_16)).toBe(0)
  })

  it('ignores control characters', () => {
    expect(getEastAsianDisplayWidth(`a${UNIT_SEPARATOR}b`)).toBe(2)
  })
})

describe('padEndToEastAsianDisplayWidth', () => {
  it('pads ASCII exactly like the built-in padEnd', () => {
    expect(padEndToEastAsianDisplayWidth('Alice', 10)).toBe('Alice'.padEnd(10))
  })

  it('pads Hangul to the requested column count', () => {
    const padded = padEndToEastAsianDisplayWidth('배현우', 10)

    expect(getEastAsianDisplayWidth(padded)).toBe(10)
    // The built-in would have produced 13 columns for the same request.
    expect(getEastAsianDisplayWidth('배현우'.padEnd(10))).toBe(13)
  })

  it('aligns Korean and Latin rows to the same column', () => {
    const korean = padEndToEastAsianDisplayWidth('배현우', 24)
    const latin = padEndToEastAsianDisplayWidth('Alice', 24)

    expect(getEastAsianDisplayWidth(korean)).toBe(getEastAsianDisplayWidth(latin))
  })

  it('returns text unchanged when it already fills the column', () => {
    expect(padEndToEastAsianDisplayWidth('배현우', 6)).toBe('배현우')
    expect(padEndToEastAsianDisplayWidth('배현우', 2)).toBe('배현우')
  })
})
