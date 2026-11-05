import { describe, expect, it } from 'vitest'
import { getRichMarkdownRangeBounds, getRichMarkdownRangeStart } from './rich-markdown-range-bounds'

describe('rich markdown range bounds', () => {
  it('finds annotation range bounds without spreading range arrays', () => {
    const ranges = Array.from({ length: 130_000 }, (_, index) => ({
      from: index + 10,
      to: index + 11
    }))
    ranges.push({ from: 3, to: 2 })
    ranges.push({ from: 200_000, to: 199_999 })

    expect(getRichMarkdownRangeStart(ranges)).toBe(2)
    expect(getRichMarkdownRangeBounds(ranges)).toEqual({
      from: 2,
      to: 200_000
    })
  })
})
