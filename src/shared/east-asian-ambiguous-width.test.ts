import { describe, expect, it } from 'vitest'
import {
  isEastAsianAmbiguous,
  resolveEastAsianAmbiguousCellWidth
} from './east-asian-ambiguous-width'

describe('isEastAsianAmbiguous', () => {
  it('classifies the Windows CJK ambiguous glyphs from #9958', () => {
    expect(isEastAsianAmbiguous(0x2460)).toBe(true) // ①
    expect(isEastAsianAmbiguous(0x25a0)).toBe(true) // ■
    expect(isEastAsianAmbiguous(0x25cf)).toBe(true) // ●
    expect(isEastAsianAmbiguous(0x2605)).toBe(true) // ★
    expect(isEastAsianAmbiguous(0x2192)).toBe(true) // →
  })

  it('keeps true wide CJK and ASCII as non-ambiguous', () => {
    expect(isEastAsianAmbiguous(0x6f22)).toBe(false) // 漢
    expect(isEastAsianAmbiguous(0xd55c)).toBe(false) // 한
    expect(isEastAsianAmbiguous(0x0041)).toBe(false) // A
    expect(isEastAsianAmbiguous(0x0020)).toBe(false) // space
  })
})

describe('resolveEastAsianAmbiguousCellWidth', () => {
  it('leaves narrow mode unchanged', () => {
    expect(resolveEastAsianAmbiguousCellWidth(0x2460, 1, 'narrow')).toBe(1)
    expect(resolveEastAsianAmbiguousCellWidth(0x6f22, 2, 'narrow')).toBe(2)
  })

  it('widens only ambiguous base-width-1 cells when wide', () => {
    expect(resolveEastAsianAmbiguousCellWidth(0x2460, 1, 'wide')).toBe(2)
    expect(resolveEastAsianAmbiguousCellWidth(0x0041, 1, 'wide')).toBe(1)
    expect(resolveEastAsianAmbiguousCellWidth(0x6f22, 2, 'wide')).toBe(2)
    expect(resolveEastAsianAmbiguousCellWidth(0x0300, 0, 'wide')).toBe(0)
  })
})
