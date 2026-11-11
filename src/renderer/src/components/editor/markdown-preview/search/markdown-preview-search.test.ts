import { describe, expect, it } from 'vitest'
import './markdown-preview-search'
import { findTextMatchRanges } from '../../../../lib/text-search/text-match-ranges'

describe('findTextMatchRanges', () => {
  it('checks whole-word boundaries around astral letters by code point', () => {
    const text = '𐐀cat cat𐐀 cat'

    expect(findTextMatchRanges(text, 'cat', { wholeWord: true })).toEqual([{ start: 12, end: 15 }])
  })
})
