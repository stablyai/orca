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

  it('pre-renders at most one viewport of small sections on each side', () => {
    expect(
      getCombinedDiffRenderRange(
        { startIndex: 4, endIndex: 5, count: 10, overscan: 5 },
        () => 200,
        400
      )
    ).toEqual([2, 3, 4, 5, 6, 7])
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

  it('retains the row-count cap and list boundaries for short sections', () => {
    expect(
      getCombinedDiffRenderRange(
        { startIndex: 1, endIndex: 2, count: 100, overscan: 5 },
        () => 28,
        800
      )
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('renders only visible sections before the viewport is measured', () => {
    expect(
      getCombinedDiffRenderRange(
        { startIndex: 1, endIndex: 2, count: 10, overscan: 5 },
        () => 88,
        0
      )
    ).toEqual([1, 2])
  })
})
