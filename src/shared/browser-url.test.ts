import { describe, expect, it } from 'vitest'
import { ORCA_BROWSER_BLANK_URL } from './constants'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  buildSearchUrl
} from './browser-url'

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

  it('rejects non-web schemes for in-app navigation', () => {
    expect(normalizeBrowserNavigationUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeExternalBrowserUrl('about:blank')).toBeNull()
  })

  // Why: "Open Preview to the Side" on an HTML file loads the file via file://
  // in the browser pane. The guest webview is sandboxed (see
  // createMainWindow.ts will-attach-webview), so rendering local HTML cannot
  // escalate privileges beyond what the editor already grants.
  it('allows file:// URLs so local HTML can be previewed', () => {
    expect(normalizeBrowserNavigationUrl('file:///Users/me/site/index.html')).toBe(
      'file:///Users/me/site/index.html'
    )
  })

  // Why: in-app preview is fine (sandboxed webview), but handing file:// to
  // shell.openExternal would let a remote page drive Finder/Explorer to
  // arbitrary paths. External-open paths must still refuse file://.
  it('rejects file:// for external opens even though it is allowed in-app', () => {
    expect(normalizeExternalBrowserUrl('file:///etc/passwd')).toBeNull()
  })

  it('returns null for non-URL input without search engine opt-in', () => {
    expect(normalizeBrowserNavigationUrl('not a url')).toBeNull()
  })

  it('attempts https:// prefix for bare words without search opt-in', () => {
    expect(normalizeBrowserNavigationUrl('singleword')).toBe('https://singleword/')
  })

  it('treats bare words and multi-word input as search queries when search is enabled', () => {
    expect(normalizeBrowserNavigationUrl('react hooks', null)).toBe(
      'https://www.google.com/search?q=react%20hooks'
    )
    expect(normalizeBrowserNavigationUrl('what is typescript', null)).toBe(
      'https://www.google.com/search?q=what%20is%20typescript'
    )
    expect(normalizeBrowserNavigationUrl('singleword', null)).toBe(
      'https://www.google.com/search?q=singleword'
    )
  })

  it('respects the search engine parameter', () => {
    expect(normalizeBrowserNavigationUrl('react hooks', 'duckduckgo')).toBe(
      'https://duckduckgo.com/?q=react%20hooks'
    )
    expect(normalizeBrowserNavigationUrl('react hooks', 'bing')).toBe(
      'https://www.bing.com/search?q=react%20hooks'
    )
  })

  it('treats domain-like inputs as URLs, not searches', () => {
    expect(normalizeBrowserNavigationUrl('example.com', null)).toBe('https://example.com/')
    expect(normalizeBrowserNavigationUrl('github.com/org/repo', null)).toBe(
      'https://github.com/org/repo'
    )
  })

  it('builds search URLs correctly', () => {
    expect(buildSearchUrl('hello world', 'google')).toBe(
      'https://www.google.com/search?q=hello%20world'
    )
    expect(buildSearchUrl('hello world', 'duckduckgo')).toBe(
      'https://duckduckgo.com/?q=hello%20world'
    )
  })
})
