import { describe, expect, it } from 'vitest'
import { getInitialCombinedDiffSectionLoadIndices } from './combined-diff-initial-section-load'

describe('combined diff initial section load', () => {
  it('queues the initial section window', () => {
    expect(
      getInitialCombinedDiffSectionLoadIndices({
        sectionCount: 10,
        loadedIndices: new Set(),
        maxCount: 4
      })
    ).toEqual([0, 1, 2, 3])
  })

  it('skips sections that were restored from cache', () => {
    expect(
      getInitialCombinedDiffSectionLoadIndices({
        sectionCount: 6,
        loadedIndices: new Set([0, 2, 5]),
        maxCount: 6
      })
    ).toEqual([1, 3, 4])
  })

  it('handles an empty diff', () => {
    expect(
      getInitialCombinedDiffSectionLoadIndices({
        sectionCount: 0,
        loadedIndices: new Set(),
        maxCount: 6
      })
    ).toEqual([])
  })
})
