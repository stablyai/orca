import { describe, expect, it } from 'vitest'
import {
  getDiffSectionBodyHeight,
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
