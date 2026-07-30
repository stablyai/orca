import { describe, expect, it } from 'vitest'
import { shouldRequestCombinedDiffSectionLoad } from './combined-diff-section-load-state'

describe('combined diff section load state', () => {
  it('requests content when a stale loaded marker has no diff result', () => {
    expect(
      shouldRequestCombinedDiffSectionLoad({ diffResult: null, error: undefined }, false)
    ).toBe(true)
  })

  it('preserves loaded and actively loading sections', () => {
    expect(
      shouldRequestCombinedDiffSectionLoad(
        {
          diffResult: {
            kind: 'text',
            originalContent: 'before',
            modifiedContent: 'after',
            originalIsBinary: false,
            modifiedIsBinary: false
          },
          error: undefined
        },
        false
      )
    ).toBe(false)
    expect(shouldRequestCombinedDiffSectionLoad({ diffResult: null, error: undefined }, true)).toBe(
      false
    )
  })
})
