import { describe, expect, it } from 'vitest'
import { ORCA_BROWSER_BLANK_URL } from './constants'
import { normalizeBrowserNavigationUrl, normalizeExternalBrowserUrl } from './browser-url'

describe('browser-url helpers', () => {
  it('normalizes manual local-dev inputs to http', () => {
    expect(normalizeBrowserNavigationUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeBrowserNavigationUrl('127.0.0.1:5173')).toBe('http://127.0.0.1:5173/')
  })

  it('keeps normal web URLs and blank tabs in the allowed set', () => {
    expect(normalizeBrowserNavigationUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeBrowserNavigationUrl('')).toBe(ORCA_BROWSER_BLANK_URL)
    expect(normalizeBrowserNavigationUrl('about:blank')).toBe(ORCA_BROWSER_BLANK_URL)
  })

  it('allows local file URLs for in-app navigation only', () => {
    expect(normalizeBrowserNavigationUrl('file:///etc/passwd')).toBe('file:///etc/passwd')
    expect(normalizeBrowserNavigationUrl('file://localhost/etc/passwd')).toBe(
      'file:///etc/passwd'
    )
    expect(normalizeBrowserNavigationUrl('file://remote-host/etc/passwd')).toBeNull()
    expect(normalizeExternalBrowserUrl('file:///etc/passwd')).toBeNull()
  })

  it('rejects non-browser schemes for in-app navigation', () => {
    expect(normalizeBrowserNavigationUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeExternalBrowserUrl('about:blank')).toBeNull()
  })
})
