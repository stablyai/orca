import { describe, expect, it } from 'vitest'
import { getMarkdownRenderMode } from './markdown-render-mode'

describe('getMarkdownRenderMode', () => {
  it('keeps explicit source mode in Monaco', () => {
    expect(
      getMarkdownRenderMode({
        hasRichModeUnsupportedContent: false,
        viewMode: 'source'
      })
    ).toBe('source')
  })

  it('uses rich editing when the markdown is supported', () => {
    expect(
      getMarkdownRenderMode({
        hasRichModeUnsupportedContent: false,
        viewMode: 'rich'
      })
    ).toBe('rich-editor')
  })

  it('falls back to plain markdown preview when rich editing is unsupported', () => {
    expect(
      getMarkdownRenderMode({
        hasRichModeUnsupportedContent: true,
        viewMode: 'rich'
      })
    ).toBe('preview')
  })
})
