import { describe, expect, it } from 'vitest'
import { findTextMatchRanges } from './markdown-preview-search'

describe('whole-word search around combining marks', () => {
  it.each(['́', 'ि'])('keeps the trailing combining mark %s attached to its word', (mark) => {
    const text = `cat${mark} cat ${mark}cat`
    expect(findTextMatchRanges(text, 'cat', { wholeWord: true })).toEqual([
      { start: 4 + mark.length, end: 7 + mark.length },
      { start: 8 + 2 * mark.length, end: 11 + 2 * mark.length }
    ])
  })

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
