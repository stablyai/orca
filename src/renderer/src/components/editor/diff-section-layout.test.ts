import { describe, expect, it } from 'vitest'
import {
  getDiffSectionBodyHeight,
  getLargeDiffFallbackBodyHeight,
  getDiffSectionEstimatedHeight,
  isIntrinsicHeightImageDiff
} from './diff-section-layout'
import type { GitDiffResult } from '../../../../shared/types'

describe('diff section layout', () => {
  it('uses Monaco measured content height for text diffs', () => {
    expect(
      getDiffSectionBodyHeight({
        measuredContentHeight: 120,
        originalContent: '',
        modifiedContent: '',
        useIntrinsicImageHeight: false
      })
    ).toBe(139)
  })

  it('uses a bounded fallback height for oversized diffs before measurement', () => {
    expect(getLargeDiffFallbackBodyHeight()).toBe(160)
  })

  it('falls back to line-count height before Monaco has mounted', () => {
    expect(
      getDiffSectionBodyHeight({
        measuredContentHeight: undefined,
        originalContent: 'one',
        modifiedContent: 'one\ntwo\nthree',
        useIntrinsicImageHeight: false
      })
    ).toBe(76)
  })

  it('uses changed-line count before Monaco reports collapsed diff height', () => {
    const largeUnchangedFile = Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join(
      '\n'
    )

    expect(
      getDiffSectionBodyHeight({
        measuredContentHeight: undefined,
        originalContent: largeUnchangedFile,
        modifiedContent: `${largeUnchangedFile}\nchanged`,
        changedLineCount: 1,
        useIntrinsicImageHeight: false
      })
    ).toBe(266)
  })

  it('caps unmeasured text diffs without changed-line stats', () => {
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
  })

  it('estimates line-count height without allocating split arrays', () => {
    const originalSplit = String.prototype.split
    const patchedSplit = function patchedSplit(
      this: string,
      separator?: unknown,
      limit?: number
    ): string[] {
      if (String(this).startsWith('line 0')) {
        throw new Error('layout should not split full diff content')
      }
      const args = limit === undefined ? [separator] : [separator, limit]
      return Reflect.apply(originalSplit, this, args) as string[]
    } as typeof String.prototype.split
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

  it('keeps empty text sections visible', () => {
    expect(
      getDiffSectionBodyHeight({
        measuredContentHeight: undefined,
        originalContent: '',
        modifiedContent: '',
        useIntrinsicImageHeight: false
      })
    ).toBe(60)
  })

  it('treats zero measured height as not laid out yet', () => {
    expect(
      getDiffSectionBodyHeight({
        measuredContentHeight: 0,
        originalContent: '',
        modifiedContent: '',
        useIntrinsicImageHeight: false
      })
    ).toBe(60)
  })

  it('lets image diffs use intrinsic height in combined diff sections', () => {
    expect(
      getDiffSectionBodyHeight({
        measuredContentHeight: undefined,
        originalContent: '',
        modifiedContent: '',
        useIntrinsicImageHeight: true
      })
    ).toBeUndefined()
  })

  it('only treats real image MIME types as intrinsic-height previews', () => {
    const pngDiff: GitDiffResult = {
      kind: 'binary',
      originalContent: '',
      modifiedContent: 'base64',
      originalIsBinary: false,
      modifiedIsBinary: true,
      isImage: true,
      mimeType: 'image/png'
    }
    const pdfDiff: GitDiffResult = {
      kind: 'binary',
      originalContent: '',
      modifiedContent: 'base64',
      originalIsBinary: false,
      modifiedIsBinary: true,
      isImage: true,
      mimeType: 'application/pdf'
    }

    expect(isIntrinsicHeightImageDiff(pngDiff)).toBe(true)
    expect(isIntrinsicHeightImageDiff(pdfDiff)).toBe(false)
  })

  it('estimates virtualized expanded section height from diff line count', () => {
    expect(
      getDiffSectionEstimatedHeight({
        collapsed: false,
        measuredContentHeight: undefined,
        originalContent: 'one',
        modifiedContent: 'one\ntwo\nthree',
        changedLineCount: 2,
        useIntrinsicImageHeight: false
      })
    ).toBe(104)
  })

  it('uses changed-line count for large virtualized expanded sections', () => {
    const largeUnchangedFile = Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join(
      '\n'
    )

    expect(
      getDiffSectionEstimatedHeight({
        collapsed: false,
        measuredContentHeight: undefined,
        originalContent: largeUnchangedFile,
        modifiedContent: `${largeUnchangedFile}\nchanged`,
        changedLineCount: 1,
        useIntrinsicImageHeight: false
      })
    ).toBe(294)
  })

  it('uses bounded fallback height for oversized virtualized sections', () => {
    expect(
      getDiffSectionEstimatedHeight({
        collapsed: false,
        measuredContentHeight: undefined,
        originalContent: '',
        modifiedContent: 'one',
        changedLineCount: 200_000,
        useIntrinsicImageHeight: false,
        isLargeDiffLimited: true
      })
    ).toBe(188)
  })

  it('ignores stale Monaco measurements for oversized virtualized sections', () => {
    expect(
      getDiffSectionEstimatedHeight({
        collapsed: false,
        measuredContentHeight: 3_800_000,
        originalContent: '',
        modifiedContent: 'one',
        changedLineCount: 200_000,
        useIntrinsicImageHeight: false,
        isLargeDiffLimited: true
      })
    ).toBe(188)
  })

  it('estimates collapsed virtualized sections as header-only rows', () => {
    expect(
      getDiffSectionEstimatedHeight({
        collapsed: true,
        measuredContentHeight: 500,
        originalContent: 'one',
        modifiedContent: 'one\ntwo\nthree',
        useIntrinsicImageHeight: false
      })
    ).toBe(28)
  })
})
