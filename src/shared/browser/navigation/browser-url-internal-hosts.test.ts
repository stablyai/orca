import { describe, expect, it } from 'vitest'
import { looksLikeSearchQuery, normalizeBrowserNavigationUrl } from './browser-url'

describe('internal addresses with paths or query params', () => {
  it('navigates single-label hosts with paths, queries, or fragments instead of searching', () => {
    expect(normalizeBrowserNavigationUrl('intranet/docs?token=secret', 'google')).toBe(
      'https://intranet/docs?token=secret'
    )
    expect(normalizeBrowserNavigationUrl('go/design', 'google')).toBe('https://go/design')
    expect(normalizeBrowserNavigationUrl('staging?api_key=123', 'google')).toBe(
      'https://staging/?api_key=123'
    )
    expect(normalizeBrowserNavigationUrl('intranet/', 'google')).toBe('https://intranet/')
    expect(normalizeBrowserNavigationUrl('intranet#section', 'google')).toBe(
      'https://intranet/#section'
    )
  })

  it('keeps bare single words and prose questions as search queries', () => {
    expect(looksLikeSearchQuery('intranet')).toBe(true)
    expect(looksLikeSearchQuery('why?')).toBe(true)
    expect(looksLikeSearchQuery('react hooks')).toBe(true)
    expect(normalizeBrowserNavigationUrl('why?', 'google')).toBe(
      'https://www.google.com/search?q=why%3F'
    )
  })

  it('keeps numeric fractions as search queries instead of IPv4 single-label hosts', () => {
    expect(looksLikeSearchQuery('24/7')).toBe(true)
    expect(looksLikeSearchQuery('9/11')).toBe(true)
    expect(looksLikeSearchQuery('3/4')).toBe(true)
    expect(normalizeBrowserNavigationUrl('24/7', 'google')).toBe(
      'https://www.google.com/search?q=24%2F7'
    )
    expect(normalizeBrowserNavigationUrl('9/11', 'google')).toBe(
      'https://www.google.com/search?q=9%2F11'
    )
    expect(normalizeBrowserNavigationUrl('3/4', 'google')).toBe(
      'https://www.google.com/search?q=3%2F4'
    )
  })
})
