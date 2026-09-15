import { describe, expect, it } from 'vitest'
import { isEquivalentBrowserPageUrl } from './browser-url-equivalence'

describe('isEquivalentBrowserPageUrl', () => {
  it('identifies equivalent browser URLs regardless of playback timestamp params', () => {
    expect(
      isEquivalentBrowserPageUrl('https://youtube.com/watch?v=1', 'https://youtube.com/watch?v=1')
    ).toBe(true)
    expect(
      isEquivalentBrowserPageUrl(
        'https://youtube.com/watch?v=1',
        'https://youtube.com/watch?v=1&t=45s'
      )
    ).toBe(true)
    expect(
      isEquivalentBrowserPageUrl(
        'https://youtube.com/watch?v=1&t=10s',
        'https://youtube.com/watch?v=1&t=45s'
      )
    ).toBe(true)
    expect(
      isEquivalentBrowserPageUrl(
        'https://youtube.com/watch?v=1&a=2&t=10s',
        'https://youtube.com/watch?t=45s&a=2&v=1'
      )
    ).toBe(true)
    expect(
      isEquivalentBrowserPageUrl('https://youtube.com/watch?v=1', 'https://youtube.com/watch?v=2')
    ).toBe(false)
    expect(
      isEquivalentBrowserPageUrl('https://youtube.com/watch?v=1', 'https://vimeo.com/watch?v=1')
    ).toBe(false)
    expect(isEquivalentBrowserPageUrl(null, null)).toBe(true)
    expect(isEquivalentBrowserPageUrl('https://youtube.com/watch?v=1', null)).toBe(false)
  })

  it('treats hash-only route and anchor differences as different pages', () => {
    expect(
      isEquivalentBrowserPageUrl(
        'https://app.example.com/#/docs',
        'https://app.example.com/#/settings'
      )
    ).toBe(false)
    expect(
      isEquivalentBrowserPageUrl(
        'https://docs.example.com/page#readme',
        'https://docs.example.com/page#license'
      )
    ).toBe(false)
    expect(
      isEquivalentBrowserPageUrl(
        'https://docs.example.com/page#readme',
        'https://docs.example.com/page#readme'
      )
    ).toBe(true)
  })

  it('keeps t params significant on hosts where t is not a playback timestamp', () => {
    expect(
      isEquivalentBrowserPageUrl(
        'https://example.com/watch?v=1&t=10',
        'https://example.com/watch?v=1&t=45'
      )
    ).toBe(false)
    expect(
      isEquivalentBrowserPageUrl(
        'https://example.com/watch?v=1&t=10',
        'https://example.com/watch?v=1&t=10'
      )
    ).toBe(true)
  })
})
