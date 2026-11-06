import { describe, expect, it } from 'vitest'
import './markdown-preview-search'
import { findTextMatchRanges } from '../../../../lib/text-match-ranges'

describe('whole-word search around combining marks', () => {
  it('does not match a Devanagari word inside a longer word ending in a vowel sign', () => {
    expect(findTextMatchRanges('किताबें किताब', 'किताब', { wholeWord: true })).toEqual([
      { start: 8, end: 13 }
    ])
  })

  it('finds a complete decomposed accented word and preserves source code-unit offsets', () => {
    const text = 'café cafe caféine'
    expect(findTextMatchRanges(text, 'café', { wholeWord: true })).toEqual([{ start: 0, end: 5 }])
    expect(findTextMatchRanges(text, 'cafe', { wholeWord: true })).toEqual([{ start: 6, end: 10 }])
    expect(findTextMatchRanges(text, 'cafe')).toHaveLength(3)
  })

  it.each([
    ['⚠️Warning here', 'Warning'],
    ['✔️Done', 'Done'],
    ['1️⃣Step', 'Step']
  ])('matches a whole word right after an emoji presentation sequence in %s', (text, query) => {
    const start = text.indexOf(query)
    expect(findTextMatchRanges(text, query, { wholeWord: true })).toEqual([
      { start, end: start + query.length }
    ])
  })
})
