import { describe, expect, it } from 'vitest'
import {
  GITHUB_MARKDOWN_IMAGE_URL_MAX_BYTES,
  getGitHubMarkdownImageUrlState,
  hasBoundedGitHubMarkdownImageUrlText,
  isGitHubMarkdownImageUrlTooLarge
} from './github-markdown-image-url'

describe('github markdown image URL input', () => {
  it('accepts bounded http and https image URLs after trimming', () => {
    expect(getGitHubMarkdownImageUrlState('  https://example.com/image.png  ')).toEqual({
      status: 'valid',
      url: 'https://example.com/image.png'
    })
    expect(getGitHubMarkdownImageUrlState('http://example.com/image.png')).toEqual({
      status: 'valid',
      url: 'http://example.com/image.png'
    })
  })

  it('rejects empty, non-http, and oversized pasted URL text safely', () => {
    const oversized = ' '.repeat(GITHUB_MARKDOWN_IMAGE_URL_MAX_BYTES + 1)

    expect(getGitHubMarkdownImageUrlState('   ')).toEqual({ status: 'empty' })
    expect(getGitHubMarkdownImageUrlState('file:///tmp/image.png')).toEqual({ status: 'invalid' })
    expect(getGitHubMarkdownImageUrlState(oversized)).toEqual({ status: 'too-large' })
    expect(hasBoundedGitHubMarkdownImageUrlText(oversized)).toBe(false)
  })

  it('enforces the URL budget by UTF-8 byte length', () => {
    const multibyteUrl = `https://example.com/${'\u00e9'.repeat(
      GITHUB_MARKDOWN_IMAGE_URL_MAX_BYTES
    )}`

    expect(isGitHubMarkdownImageUrlTooLarge(multibyteUrl)).toBe(true)
  })
})
