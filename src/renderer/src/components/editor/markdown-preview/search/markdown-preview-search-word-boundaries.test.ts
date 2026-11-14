import { describe, expect, it } from 'vitest'
import './markdown-preview-search'
import { findTextMatchRanges } from '../../../../lib/text-search/text-match-ranges'

describe('whole-word search around combining marks', () => {
  it('finds a complete decomposed accented word and preserves source code-unit offsets', () => {
    const text = 'café cafe caféine'
    expect(findTextMatchRanges(text, 'café', { wholeWord: true })).toEqual([{ start: 0, end: 5 }])
    expect(findTextMatchRanges(text, 'cafe', { wholeWord: true })).toEqual([{ start: 6, end: 10 }])
    expect(findTextMatchRanges(text, 'cafe')).toHaveLength(3)
  })
})
