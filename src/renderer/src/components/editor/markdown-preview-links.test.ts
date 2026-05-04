import { describe, expect, it } from 'vitest'
import {
  fileUrlToAbsolutePath,
  getMarkdownPreviewImageSrc,
  getMarkdownPreviewLinkTarget,
  resolveMarkdownPreviewHref,
  resolveImageAbsolutePath
} from './markdown-preview-links'

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

describe('resolveMarkdownPreviewHref', () => {
  it('resolves markdown fragments against the current file path', () => {
    expect(
      resolveMarkdownPreviewHref('./guide/setup.md#install', '/repo/docs/README.md')?.toString()
    ).toBe('file:///repo/docs/guide/setup.md#install')
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

describe('resolveImageAbsolutePath', () => {
  it('resolves a relative image src to an absolute filesystem path', () => {
    expect(resolveImageAbsolutePath('diagram.png', '/repo/docs/README.md')).toBe(
      '/repo/docs/diagram.png'
    )
  })

  it('resolves parent-directory references', () => {
    expect(resolveImageAbsolutePath('../assets/img.png', '/repo/docs/guides/README.md')).toBe(
      '/repo/docs/assets/img.png'
    )
  })

  it('resolves Windows paths', () => {
    expect(resolveImageAbsolutePath('./diagram.png', 'C:\\repo\\docs\\README.md')).toBe(
      'C:/repo/docs/diagram.png'
    )
  })

  it('returns null for http URLs', () => {
    expect(resolveImageAbsolutePath('https://example.com/img.png', '/repo/README.md')).toBeNull()
  })

  it('returns null for data URLs', () => {
    expect(resolveImageAbsolutePath('data:image/png;base64,abc', '/repo/README.md')).toBeNull()
  })

  it('returns null for undefined src', () => {
    expect(resolveImageAbsolutePath(undefined, '/repo/README.md')).toBeNull()
  })
})

describe('fileUrlToAbsolutePath', () => {
  it('converts unix file URLs to absolute paths', () => {
    expect(fileUrlToAbsolutePath(new URL('file:///repo/docs/README.md'))).toBe(
      '/repo/docs/README.md'
    )
  })

  it('converts windows file URLs to absolute paths', () => {
    expect(fileUrlToAbsolutePath(new URL('file:///C:/repo/docs/README.md'))).toBe(
      'C:/repo/docs/README.md'
    )
  })

  it('returns null for non-file URLs', () => {
    expect(fileUrlToAbsolutePath(new URL('https://example.com/readme.md'))).toBeNull()
  })
})
