import { describe, expect, it } from 'vitest'
import { nextDiffReviewEntry } from './diff-review-navigation'

const entries = ['a', 'b', 'c'].map((key) => ({ key, entrySignature: key, open: () => {} }))
describe('Viewed file navigation', () => {
  it('advances, wraps, and stays on a single file', () => {
    expect(nextDiffReviewEntry(entries, 'a', new Map())?.key).toBe('b')
    expect(
      nextDiffReviewEntry(
        entries,
        'c',
        new Map([
          ['a', { viewedAt: 1, modifiedTime: 1, contentSignature: '', entrySignature: 'a' }],
          ['b', { viewedAt: 1, modifiedTime: 1, contentSignature: '', entrySignature: 'b' }]
        ])
      )?.key
    ).toBe('a')
    expect(nextDiffReviewEntry(entries.slice(0, 1), 'a', new Map())).toBeUndefined()
  })
  it('moves backward when marking the last unviewed entry in the current order with other unviewed files remaining', () => {
    expect(nextDiffReviewEntry(entries, 'c', new Map())?.key).toBe('b')
    expect(nextDiffReviewEntry(entries, 'missing', new Map())).toBeUndefined()
  })
  it('skips viewed neighbors in both directions', () => {
    const records = new Map([
      ['b', { viewedAt: 1, modifiedTime: null, contentSignature: '', entrySignature: 'b' }]
    ])
    expect(nextDiffReviewEntry(entries, 'a', records)?.key).toBe('c')
    expect(nextDiffReviewEntry(entries, 'c', records)?.key).toBe('a')
  })
})
