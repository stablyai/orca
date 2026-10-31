import { describe, expect, it } from 'vitest'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
import {
  MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES,
  canRenderMarkdownAtSize,
  exceedsMarkdownRenderOverrideSizeLimit
} from './markdown-rich-size-limit'

describe('exceedsMarkdownRenderOverrideSizeLimit', () => {
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
