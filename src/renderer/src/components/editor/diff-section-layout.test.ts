import { describe, expect, it } from 'vitest'
import { getDiffSectionBodyHeight, isIntrinsicHeightImageDiff } from './diff-section-layout'
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
})
