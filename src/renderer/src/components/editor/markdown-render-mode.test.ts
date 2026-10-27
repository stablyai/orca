import { describe, expect, it } from 'vitest'
import { getMarkdownRenderMode } from './markdown-render-mode'

describe('getMarkdownRenderMode', () => {
  it('renders a preview when rich editing cannot preserve the source', () => {
    expect(
      getMarkdownRenderMode({
        exceedsRichModeSizeLimit: false,
        hasRichModeUnsupportedContent: true,
        viewMode: 'rich'
      })
    ).toBe('preview')
  })

  it('keeps oversized unsupported documents in source mode', () => {
    expect(
      getMarkdownRenderMode({
        exceedsRichModeSizeLimit: true,
        hasRichModeUnsupportedContent: true,
        viewMode: 'rich'
      })
    ).toBe('source')
  })
})
