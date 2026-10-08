import { describe, expect, it } from 'vitest'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
import {
  MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES,
  canRenderMarkdownAtSize,
  exceedsMarkdownRenderOverrideSizeLimit,
  exceedsMarkdownRichModeSizeLimit
} from './markdown-rich-size-limit'

describe('exceedsMarkdownRichModeSizeLimit', () => {
  it('uses a 600 KB default rich-mode ceiling', () => {
    expect(RICH_MARKDOWN_MAX_SIZE_BYTES).toBe(600 * 1024)
  })

  it('allows markdown at the rich-mode byte limit', () => {
    expect(exceedsMarkdownRichModeSizeLimit('a'.repeat(RICH_MARKDOWN_MAX_SIZE_BYTES))).toBe(false)
  })

  it('detects markdown over the byte limit', () => {
    expect(exceedsMarkdownRichModeSizeLimit('a'.repeat(RICH_MARKDOWN_MAX_SIZE_BYTES + 1))).toBe(
      true
    )
  })

  it('detects unread multibyte content at the byte boundary', () => {
    expect(
      exceedsMarkdownRichModeSizeLimit(`${'a'.repeat(RICH_MARKDOWN_MAX_SIZE_BYTES)}\u00e9`)
    ).toBe(true)
  })
})

describe('exceedsMarkdownRenderOverrideSizeLimit', () => {
  it('allows exactly the override limit and rejects one byte over', () => {
    const limit = MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES
    expect(exceedsMarkdownRenderOverrideSizeLimit('a'.repeat(limit))).toBe(false)
    expect(exceedsMarkdownRenderOverrideSizeLimit('a'.repeat(limit + 1))).toBe(true)
  })

  it('counts UTF-8 bytes, not UTF-16 length', () => {
    const limit = MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES
    // 3-byte CJK chars: floor(limit / 3) fit, one more does not.
    expect(exceedsMarkdownRenderOverrideSizeLimit('中'.repeat(Math.floor(limit / 3)))).toBe(false)
    expect(exceedsMarkdownRenderOverrideSizeLimit('中'.repeat(Math.floor(limit / 3) + 1))).toBe(
      true
    )
    // Surrogate pairs are 2 UTF-16 units but 4 bytes.
    expect(exceedsMarkdownRenderOverrideSizeLimit('😀'.repeat(limit / 4))).toBe(false)
    expect(exceedsMarkdownRenderOverrideSizeLimit(`${'😀'.repeat(limit / 4)}a`)).toBe(true)
  })

  it('lets the override lift only the rich limit, never the hard cap', () => {
    const medium = 'a'.repeat(RICH_MARKDOWN_MAX_SIZE_BYTES + 1)
    const huge = 'a'.repeat(MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES + 1)
    expect(canRenderMarkdownAtSize(medium, false)).toBe(false)
    expect(canRenderMarkdownAtSize(medium, true)).toBe(true)
    expect(canRenderMarkdownAtSize(huge, true)).toBe(false)
  })
})
