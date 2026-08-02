import { describe, expect, it } from 'vitest'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
import { exceedsMarkdownRichModeSizeLimit } from './markdown-rich-size-limit'

describe('exceedsMarkdownRichModeSizeLimit', () => {
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
