import { afterEach, describe, expect, it, vi } from 'vitest'
import './markdown-preview-search'
import { findTextMatchRanges } from '../../../../lib/text-match-ranges'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('case-insensitive Markdown search offsets', () => {
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
})
