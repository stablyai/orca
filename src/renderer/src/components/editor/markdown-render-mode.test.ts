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

  it('keeps explicit preview mode in the rendered preview', () => {
    expect(
      getMarkdownRenderMode({
        exceedsRichModeSizeLimit: true,
        hasRichModeUnsupportedContent: true,
        viewMode: 'preview'
      })
    ).toBe('preview')
  })

  it('falls back to source mode when rich editing is unsupported', () => {
    expect(
      getMarkdownRenderMode({
        exceedsRichModeSizeLimit: false,
        hasRichModeUnsupportedContent: true,
        viewMode: 'rich'
      })
    ).toBe('source')
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
