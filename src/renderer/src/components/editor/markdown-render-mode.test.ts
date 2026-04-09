import { describe, expect, it } from 'vitest'
import { getMarkdownRenderMode } from './markdown-render-mode'

describe('getMarkdownRenderMode', () => {
  it('keeps explicit source mode in Monaco', () => {
    expect(
      getMarkdownRenderMode({
        exceedsRichModeSizeLimit: false,
        hasRichModeUnsupportedContent: false,
        viewMode: 'source'
      })
    ).toBe('source')
  })

  it('uses rich editing when the markdown is supported', () => {
    expect(
      getMarkdownRenderMode({
        exceedsRichModeSizeLimit: false,
        hasRichModeUnsupportedContent: false,
        viewMode: 'rich'
      })
    ).toBe('rich-editor')
  })

  it('falls back to plain markdown preview when rich editing is unsupported', () => {
    expect(
      getMarkdownRenderMode({
        exceedsRichModeSizeLimit: false,
        hasRichModeUnsupportedContent: true,
        viewMode: 'rich'
      })
    ).toBe('preview')
  })

  it('falls back to source mode when the markdown is too large for rich editing', () => {
    expect(
      getMarkdownRenderMode({
        exceedsRichModeSizeLimit: true,
        hasRichModeUnsupportedContent: false,
        viewMode: 'rich'
      })
    ).toBe('source')
  })
})
