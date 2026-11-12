import { describe, expect, it } from 'vitest'
import './markdown-preview-search'
import { findTextMatchRanges } from '../../../../lib/text-search/text-match-ranges'

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
})
