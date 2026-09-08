import { describe, expect, it } from 'vitest'
import { isMobileWebPageBrowserNavigationUrl, mobileWebPageBrowserUrl } from './browser-url-privacy'

describe('mobileWebPageBrowserUrl', () => {
  it.each([
    [
      'https://user:password@example.com/path?view=grid&access_token=secret#section',
      'https://example.com/path?view=grid#section'
    ],
    [
      'https://example.com/callback?code=secret&state=private&tab=review',
      'https://example.com/callback?tab=review'
    ],
    [
      'https://storage.example/object?x-amz-signature=secret&part=1',
      'https://storage.example/object?part=1'
    ],
    [
      'https://storage.example/object?X-Goog-Credential=secret&part=1',
      'https://storage.example/object?part=1'
    ],
    [
      'https://example.com/callback?id_token=secret&view=mobile',
      'https://example.com/callback?view=mobile'
    ],
    [
      'https://ci.example.com/deploy?run=1&sessionToken=secret',
      'https://ci.example.com/deploy?run=1'
    ],
    ['https://example.com/?jwt=secret&view=mobile', 'https://example.com/?view=mobile'],
    ['https://example.com/?private_key=secret&view=mobile', 'https://example.com/?view=mobile'],
    ['https://example.com/?client.secret=secret&view=mobile', 'https://example.com/?view=mobile'],
    ['https://example.com/#access_token=secret', 'https://example.com/'],
    ['https://example.com/#/callback?refresh_token=secret&view=mobile', 'https://example.com/'],
    ['file:///private/repository/secret.txt', 'file:///[redacted]']
  ])('removes credentials from %s', (value, expected) => {
    expect(mobileWebPageBrowserUrl(value)).toBe(expected)
  })

  it('preserves ordinary URL state and rejects unsupported or invalid URLs', () => {
    expect(mobileWebPageBrowserUrl('https://example.com/search?q=orca#results')).toBe(
      'https://example.com/search?q=orca#results'
    )
    expect(mobileWebPageBrowserUrl('https://example.com')).toBe('https://example.com')
    expect(mobileWebPageBrowserUrl('javascript:alert(1)')).toBe('about:blank')
    expect(mobileWebPageBrowserUrl('not a url')).toBe('about:blank')
    expect(mobileWebPageBrowserUrl(`https://example.com/?q=${'a'.repeat(4096)}`)).toBe(
      'about:blank'
    )
  })

  it('admits only credential-free hosted navigation URLs', () => {
    expect(isMobileWebPageBrowserNavigationUrl('https://example.com/search?q=orca')).toBe(true)
    expect(isMobileWebPageBrowserNavigationUrl('about:blank')).toBe(true)
    for (const value of [
      'https://user:password@example.com/',
      'https://example.com/?token=secret',
      'https://example.com/#access_token=secret',
      'https://example.com/#/callback?refresh_token=secret',
      `https://example.com/?q=${'a'.repeat(4096)}`,
      'file:///private/repository/secret.txt',
      'javascript:alert(1)'
    ]) {
      expect(isMobileWebPageBrowserNavigationUrl(value)).toBe(false)
    }
  })
})
