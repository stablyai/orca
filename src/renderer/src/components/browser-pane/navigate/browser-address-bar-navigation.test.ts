import { describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  browserDefaultSearchEngine: 'google' as string | null,
  browserKagiSessionLink: null as string | null
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => storeState }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { resolveBrowserAddressBarSubmission } from './browser-address-bar-navigation'

describe('resolveBrowserAddressBarSubmission', () => {
  it('falls back to the configured search engine instead of parsing a query as a host', () => {
    storeState.browserDefaultSearchEngine = 'google'
    expect(resolveBrowserAddressBarSubmission('google maps')).toEqual({
      status: 'navigate',
      url: 'https://www.google.com/search?q=google%20maps'
    })

    storeState.browserDefaultSearchEngine = 'duckduckgo'
    expect(resolveBrowserAddressBarSubmission('google maps')).toMatchObject({
      status: 'navigate',
      url: expect.stringContaining('duckduckgo.com')
    })
    storeState.browserDefaultSearchEngine = 'google'
  })

  it('routes searches through the Kagi session link when one is configured', () => {
    storeState.browserDefaultSearchEngine = 'kagi'
    storeState.browserKagiSessionLink = 'https://kagi.com/search?token=secret-token'
    expect(resolveBrowserAddressBarSubmission('orca browser')).toMatchObject({
      status: 'navigate',
      url: expect.stringContaining('secret-token')
    })
    storeState.browserDefaultSearchEngine = 'google'
    storeState.browserKagiSessionLink = null
  })

  it('reports unsupported schemes as an invalid-input failure rather than navigating', () => {
    expect(resolveBrowserAddressBarSubmission('javascript:alert(1)')).toEqual({
      status: 'invalid',
      loadError: {
        code: 0,
        description: 'Enter a valid http(s) or localhost URL.',
        validatedUrl: 'javascript:alert(1)'
      }
    })
  })

  it('treats blank input as the blank page rather than an error', () => {
    expect(resolveBrowserAddressBarSubmission('   ')).toMatchObject({ status: 'navigate' })
  })
})
