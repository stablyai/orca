import { describe, expect, it } from 'vitest'
import {
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES
} from './mobile-markdown-document'

describe('mobile markdown document byte accounting', () => {
  it('keeps markdown content limit checks bounded for oversized multibyte text', () => {
    const oversized = '😀'.repeat(Math.floor(MOBILE_MARKDOWN_EDIT_MAX_BYTES / 4) + 1)
    const accepted = '😀'.repeat(Math.floor(MOBILE_MARKDOWN_EDIT_MAX_BYTES / 4))

    expect(isMarkdownContentByteLengthOverLimit(oversized, MOBILE_MARKDOWN_EDIT_MAX_BYTES)).toBe(
      true
    )
    expect(isMarkdownContentByteLengthOverLimit(accepted, MOBILE_MARKDOWN_EDIT_MAX_BYTES)).toBe(
      false
    )
  })
})
