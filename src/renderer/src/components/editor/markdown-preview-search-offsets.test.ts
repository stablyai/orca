import { afterEach, describe, expect, it, vi } from 'vitest'
import { findTextMatchRanges } from './markdown-preview-search'

function mockLowercaseLocale(locale: string): void {
  const lowercase = String.prototype.toLocaleLowerCase
  vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
    return lowercase.call(this, locale)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('case-insensitive Markdown search offsets', () => {
  it('finds a match at the end of a large ordinary text node', () => {
    const prefix = 'a'.repeat(512 * 1024)
    expect(findTextMatchRanges(`${prefix} Needle`, 'needle')).toEqual([
      { start: prefix.length + 1, end: prefix.length + 7 }
    ])
  })

  it.each([
    { character: 'İ', first: 9, second: 18 },
    { character: '😊', first: 10, second: 20 },
    { character: '𐐀', first: 10, second: 20 }
  ])('keeps offsets across an ordinary prefix and $character', ({ character, first, second }) => {
    const text = `Prefix ${character} NEEDLE ${character} needle`
    expect(findTextMatchRanges(text, 'needle')).toEqual([
      { start: first, end: first + 6 },
      { start: second, end: second + 6 }
    ])
  })

  it('preserves whole code-point ranges for lone surrogate queries', () => {
    const text = 'plain😊plain'
    expect(findTextMatchRanges(text, '\ud83d')).toEqual([{ start: 5, end: 7 }])
    expect(findTextMatchRanges(text, '\ude0a')).toEqual([{ start: 5, end: 7 }])
  })

  it('keeps character-wise Greek sigma casing in a Unicode document', () => {
    expect(findTextMatchRanges('AΣ Aς Aσ', 'aσ')).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 8 }
    ])
  })

  it.each([
    { locale: 'en-US', dotted: [0, 2, 4], dotless: [6] },
    { locale: 'tr', dotted: [2, 4], dotless: [0, 6] },
    { locale: 'az', dotted: [2, 4], dotless: [0, 6] },
    { locale: 'lt', dotted: [0, 2, 4], dotless: [6] },
    { locale: 'el', dotted: [0, 2, 4], dotless: [6] }
  ])('respects dotted and dotless I in $locale', ({ locale, dotted, dotless }) => {
    mockLowercaseLocale(locale)
    expect(findTextMatchRanges('I i İ ı', 'i')).toEqual(
      dotted.map((start) => ({ start, end: start + 1 }))
    )
    expect(findTextMatchRanges('I i İ ı', 'ı')).toEqual(
      dotless.map((start) => ({ start, end: start + 1 }))
    )
  })
})
