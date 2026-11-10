import { describe, expect, it } from 'vitest'
import './markdown-preview-search'
import { findTextMatchRanges } from '../../../../lib/text-search/text-match-ranges'

describe('findTextMatchRanges', () => {
  it('folds uppercase Greek queries the same way as the indexed text', () => {
    expect(findTextMatchRanges('ΟΣ οσ ος', 'ΟΣ')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 }
    ])
    expect(findTextMatchRanges('ΟΣ οσ', 'ΟΣ', { matchCase: true })).toEqual([{ start: 0, end: 2 }])
  })

  it('checks whole-word boundaries around astral letters by code point', () => {
    const text = '𐐀cat cat𐐀 cat'

    expect(findTextMatchRanges(text, 'cat', { wholeWord: true })).toEqual([{ start: 12, end: 15 }])
  })
})
