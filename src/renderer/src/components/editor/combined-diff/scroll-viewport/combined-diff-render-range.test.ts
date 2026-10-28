import { describe, expect, it } from 'vitest'
import { getCombinedDiffRenderRange } from './combined-diff-render-range'

describe('combined diff render range', () => {
  it('keeps visible large sections without mounting their large neighbors', () => {
    expect(
      getCombinedDiffRenderRange(
        { startIndex: 2, endIndex: 3, count: 8, overscan: 5 },
        () => 230_000,
        800
      )
    ).toEqual([2, 3])
  })

  it('stops at a large neighboring section instead of skipping across it', () => {
    const heights = [100, 230_000, 100, 100, 230_000, 100]
    expect(
      getCombinedDiffRenderRange(
        { startIndex: 2, endIndex: 2, count: heights.length, overscan: 5 },
        (index) => heights[index],
        800
      )
    ).toEqual([2, 3])
  })
})
