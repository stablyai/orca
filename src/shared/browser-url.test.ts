import { describe, expect, it } from 'vitest'
import { ORCA_BROWSER_BLANK_URL } from './constants'
import {
  buildSearchUrl,
  normalizeKagiSessionLink,
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
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

  it('normalizes pasted absolute local paths to file URLs', () => {
    expect(normalizeBrowserNavigationUrl('/Users/me/Downloads/Example.ipynb')).toBe(
      'file:///Users/me/Downloads/Example.ipynb'
    )
    expect(normalizeBrowserNavigationUrl('C:\\Users\\me\\Downloads\\Example.ipynb')).toBe(
      'file:///C:/Users/me/Downloads/Example.ipynb'
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
    expect(normalizeBrowserNavigationUrl('react hooks', 'kagi')).toBe(
      'https://kagi.com/search?q=react%20hooks'
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
    expect(buildSearchUrl('hello world', 'kagi')).toBe('https://kagi.com/search?q=hello%20world')
  })

  it('uses a Kagi private session link when configured', () => {
    const sessionLink = 'https://kagi.com/search?token=secret&q=%s#ignored'
    expect(normalizeKagiSessionLink(sessionLink)).toBe('https://kagi.com/search?token=secret')
    expect(
      buildSearchUrl('hello world', 'kagi', {
        kagiSessionLink: sessionLink
      })
    ).toBe('https://kagi.com/search?token=secret&q=hello+world')
    expect(
      normalizeBrowserNavigationUrl('hello world', 'kagi', {
        kagiSessionLink: sessionLink
      })
    ).toBe('https://kagi.com/search?token=secret&q=hello+world')
  })

  it('rejects invalid Kagi private session links', () => {
    expect(normalizeKagiSessionLink('https://kagi.com/search?q=%s')).toBeNull()
    expect(normalizeKagiSessionLink('http://kagi.com/search?token=secret')).toBeNull()
    expect(normalizeKagiSessionLink('https://example.com/search?token=secret')).toBeNull()
    expect(normalizeKagiSessionLink('https://user:pass@kagi.com/search?token=secret')).toBeNull()
    expect(normalizeKagiSessionLink('https://kagi.com:8443/search?token=secret')).toBeNull()
  })

  it('accepts kagi.com/search/ with trailing slash', () => {
    expect(normalizeKagiSessionLink('https://kagi.com/search/?token=secret')).toBe(
      'https://kagi.com/search/?token=secret'
    )
  })

  it('collapses duplicate token params in Kagi private session links', () => {
    expect(normalizeKagiSessionLink('https://kagi.com/search?token=A&token=B')).toBe(
      'https://kagi.com/search?token=A'
    )
  })

  it('redacts Kagi private session tokens from displayable URLs', () => {
    expect(redactKagiSessionToken('https://kagi.com/search?token=secret&q=hello+world')).toBe(
      'https://kagi.com/search?q=hello+world'
    )
    expect(redactKagiSessionToken('https://kagi.com/search?q=hello+world')).toBe(
      'https://kagi.com/search?q=hello+world'
    )
    expect(redactKagiSessionToken('https://kagi.com/search/?token=secret&q=hi')).toBe(
      'https://kagi.com/search/?q=hi'
    )
  })
})
