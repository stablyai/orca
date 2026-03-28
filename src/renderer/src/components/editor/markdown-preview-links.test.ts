import { describe, expect, it } from 'vitest'
import { getMarkdownPreviewImageSrc, getMarkdownPreviewLinkTarget } from './markdown-preview-links'

describe('getMarkdownPreviewLinkTarget', () => {
  it('resolves relative markdown links against the current file', () => {
    expect(getMarkdownPreviewLinkTarget('./guide/setup.md', '/repo/docs/README.md')).toBe(
      'file:///repo/docs/guide/setup.md'
    )
  })

  it('preserves external links', () => {
    expect(getMarkdownPreviewLinkTarget('https://example.com/docs', '/repo/docs/README.md')).toBe(
      'https://example.com/docs'
    )
  })

  it('does not hijack hash-only anchors', () => {
    expect(getMarkdownPreviewLinkTarget('#overview', '/repo/docs/README.md')).toBeNull()
  })
})

describe('getMarkdownPreviewImageSrc', () => {
  it('resolves relative image paths against the current file', () => {
    expect(getMarkdownPreviewImageSrc('../assets/diagram.png', '/repo/docs/guides/README.md')).toBe(
      'file:///repo/docs/assets/diagram.png'
    )
  })

  it('resolves relative paths for Windows markdown files', () => {
    expect(getMarkdownPreviewImageSrc('./diagram.png', 'C:\\repo\\docs\\README.md')).toBe(
      'file:///C:/repo/docs/diagram.png'
    )
  })

  it('leaves unsupported schemes unchanged', () => {
    expect(getMarkdownPreviewImageSrc('data:image/png;base64,abc', '/repo/docs/README.md')).toBe(
      'data:image/png;base64,abc'
    )
  })
})
