import { describe, expect, it, vi } from 'vitest'
import {
  hashMarkdownContent,
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  utf8ByteLength
} from './mobile-markdown-document'

describe('mobile markdown document byte accounting', () => {
  it('measures UTF-8 bytes across multibyte code points', () => {
    expect(utf8ByteLength('aé中😀')).toBe(10)
  })

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

  it('does not depend on TextEncoder for byte length checks', () => {
    const OriginalTextEncoder = globalThis.TextEncoder
    vi.stubGlobal(
      'TextEncoder',
      class {
        encode(): Uint8Array {
          throw new Error('full-buffer encoding should not be used')
        }
      }
    )

    try {
      expect(utf8ByteLength('😀')).toBe(4)
      expect(isMarkdownContentByteLengthOverLimit('😀', 3)).toBe(true)
    } finally {
      vi.stubGlobal('TextEncoder', OriginalTextEncoder)
    }
  })

  it('keeps content hashes prefixed with exact byte length', () => {
    expect(hashMarkdownContent('😀')).toMatch(/^content:4:/)
  })
})
