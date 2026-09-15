import { describe, expect, it } from 'vitest'

import { containsStrongRtlText, isStrongRtlCodePoint } from './strong-rtl-text'

describe('isStrongRtlCodePoint', () => {
  it('classifies Arabic and Hebrew letters as strong RTL', () => {
    expect(isStrongRtlCodePoint('م'.codePointAt(0)!)).toBe(true)
    expect(isStrongRtlCodePoint('ش'.codePointAt(0)!)).toBe(true)
    expect(isStrongRtlCodePoint('א'.codePointAt(0)!)).toBe(true)
    // Arabic presentation forms (legacy shaped codepoints).
    expect(isStrongRtlCodePoint(0xfe8d)).toBe(true)
    // Adlam (supplementary plane).
    expect(isStrongRtlCodePoint(0x1e900)).toBe(true)
  })

  it('does not classify Latin, box drawing, CJK, or emoji as RTL', () => {
    expect(isStrongRtlCodePoint('a'.codePointAt(0)!)).toBe(false)
    expect(isStrongRtlCodePoint('│'.codePointAt(0)!)).toBe(false)
    expect(isStrongRtlCodePoint('漢'.codePointAt(0)!)).toBe(false)
    expect(isStrongRtlCodePoint(0x1f600)).toBe(false)
  })
})

describe('containsStrongRtlText', () => {
  it('detects Hebrew and Arabic anywhere in the string', () => {
    expect(containsStrongRtlText('shalom \u05e9\u05dc\u05d5\u05dd')).toBe(true)
    expect(containsStrongRtlText('\u0645\u0631\u062d\u0628\u0627 world')).toBe(true)
  })

  it('rejects LTR text, box drawing, CJK, and emoji', () => {
    expect(containsStrongRtlText('const value = 1 // caf\u00e9')).toBe(false)
    expect(containsStrongRtlText('\u2502\u2500\u2518 \u6f22\u5b57 \ud83d\ude00')).toBe(false)
    expect(containsStrongRtlText('')).toBe(false)
  })

  it('decodes surrogate pairs so supplementary-plane RTL is not missed', () => {
    // Adlam letter (U+1E900) as a surrogate pair.
    expect(containsStrongRtlText('abc\u{1e900}')).toBe(true)
    // Emoji shares the high-surrogate range but is not RTL.
    expect(containsStrongRtlText('abc\u{1f600}')).toBe(false)
  })

  it('does not treat a lone high surrogate at the end as RTL', () => {
    expect(containsStrongRtlText('abc\ud83d')).toBe(false)
  })
})
