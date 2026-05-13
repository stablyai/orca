import { describe, expect, it } from 'vitest'
import { markdownPreviewUrlTransform } from './markdown-preview-url-transform'

describe('markdownPreviewUrlTransform', () => {
  it('preserves file URLs for preview links and images', () => {
    expect(markdownPreviewUrlTransform('file:///tmp/screenshot.png', 'src')).toBe(
      'file:///tmp/screenshot.png'
    )
    expect(markdownPreviewUrlTransform('file:///tmp/screenshot.png', 'href')).toBe(
      'file:///tmp/screenshot.png'
    )
  })

  it('keeps react-markdown defaults for unsafe protocols', () => {
    expect(markdownPreviewUrlTransform('javascript:alert(1)', 'href')).toBe('')
    expect(markdownPreviewUrlTransform('file:///tmp/screenshot.png', 'cite')).toBe('')
  })
})
