import { describe, expect, it } from 'vitest'
import {
  MAX_PERSISTED_BROWSER_FAVICON_URL_LENGTH,
  browserNavigationChangesFaviconOrigin,
  firstBrowserFaviconUrl,
  normalizeBrowserFaviconUrl,
  normalizePersistedBrowserFaviconUrl
} from './browser-favicon-url'

describe('normalizeBrowserFaviconUrl', () => {
  it('accepts web and bounded image data URLs', () => {
    expect(normalizeBrowserFaviconUrl(' https://example.com/icon.png ')).toBe(
      'https://example.com/icon.png'
    )
    expect(normalizeBrowserFaviconUrl('data:image/png;base64,AAAA')).toBe(
      'data:image/png;base64,AAAA'
    )
  })

  it('rejects unsupported URLs', () => {
    expect(normalizeBrowserFaviconUrl('file:///tmp/icon.png')).toBeNull()
  })

  it('bounds persisted favicons without restricting live display', () => {
    const oversized = `data:image/png,${'a'.repeat(MAX_PERSISTED_BROWSER_FAVICON_URL_LENGTH)}`
    expect(normalizeBrowserFaviconUrl(oversized)).toBe(oversized)
    expect(normalizePersistedBrowserFaviconUrl(oversized)).toBeNull()
  })

  it('takes the first usable favicon', () => {
    expect(firstBrowserFaviconUrl(['data:,', 'https://example.com/icon.png'])).toBe(
      'https://example.com/icon.png'
    )
  })
})

describe('browserNavigationChangesFaviconOrigin', () => {
  it('retains same-origin favicons and clears cross-origin ones', () => {
    expect(
      browserNavigationChangesFaviconOrigin('https://example.com/one', 'https://example.com/two')
    ).toBe(false)
    expect(
      browserNavigationChangesFaviconOrigin('https://example.com', 'https://example.org')
    ).toBe(true)
  })

  it('clears favicons for non-web destinations but preserves them when origin is unknown', () => {
    expect(browserNavigationChangesFaviconOrigin('https://example.com', 'about:blank')).toBe(true)
    expect(browserNavigationChangesFaviconOrigin(null, 'https://example.com')).toBe(false)
  })
})
