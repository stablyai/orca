import { describe, expect, it } from 'vitest'
import { getDiffSectionBodyHeight } from './diff-section-layout'

describe('diff section layout', () => {
  it('estimates line-count height without allocating split arrays', () => {
    // Method-shaped type: a call-signature capture would reject `split`'s splitter-object overload.
    const originalSplit: { split(separator: unknown, limit?: number): string[] }['split'] =
      String.prototype.split
    const patchedSplit: typeof String.prototype.split = function patchedSplit(
      this: string,
      separator?: unknown,
      limit?: number
    ): string[] {
      if (String(this).startsWith('line 0')) {
        throw new Error('layout should not split full diff content')
      }
      return originalSplit.call(this, separator, limit)
    }
    String.prototype.split = patchedSplit

    try {
      const largeUnchangedFile = Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join(
        '\n'
      )

      expect(
        getDiffSectionBodyHeight({
          measuredContentHeight: undefined,
          originalContent: largeUnchangedFile,
          modifiedContent: `${largeUnchangedFile}\nchanged`,
          useIntrinsicImageHeight: false
        })
      ).toBe(1539)
    } finally {
      String.prototype.split = originalSplit
    }
  })
})
