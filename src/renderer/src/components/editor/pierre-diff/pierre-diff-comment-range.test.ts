import { describe, expect, it } from 'vitest'
import { canCommentOnPierreRange } from './pierre-diff-comment-range'

describe('Pierre comment eligibility', () => {
  it('requires every line in a review range, including backwards selections', () => {
    const eligible = new Set([10, 11, 12, 14])
    expect(canCommentOnPierreRange({ start: 10, end: 12, side: 'additions' }, eligible)).toBe(true)
    expect(canCommentOnPierreRange({ start: 12, end: 10, side: 'additions' }, eligible)).toBe(true)
    expect(canCommentOnPierreRange({ start: 10, end: 14, side: 'additions' }, eligible)).toBe(false)
    expect(canCommentOnPierreRange({ start: 14, end: 10, side: 'additions' }, eligible)).toBe(false)
    expect(canCommentOnPierreRange({ start: 10, end: 10, side: 'additions' }, new Set())).toBe(
      false
    )
  })

  it('rejects original-side and cross-side selections', () => {
    expect(canCommentOnPierreRange({ start: 1, end: 2, side: 'deletions' }, null)).toBe(false)
    expect(
      canCommentOnPierreRange({ start: 1, end: 2, side: 'additions', endSide: 'deletions' }, null)
    ).toBe(false)
    expect(
      canCommentOnPierreRange({ start: 1, end: 2, side: 'deletions', endSide: 'additions' }, null)
    ).toBe(false)
  })

  it('allows local modified context while rejecting invalid anchors', () => {
    expect(canCommentOnPierreRange({ start: 1, end: 20 }, null)).toBe(true)
    for (const start of [0, -1, 1.5, Infinity, Number.NaN]) {
      expect(canCommentOnPierreRange({ start, end: 20 }, null)).toBe(false)
    }
  })
})
