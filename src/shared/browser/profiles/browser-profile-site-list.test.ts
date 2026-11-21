import { describe, expect, it } from 'vitest'

import {
  compileBrowserSiteList,
  isSiteListEntryCovered,
  isUrlAllowedBySiteList,
  normalizeBrowserSiteListEntries,
  normalizeBrowserSiteListEntry
} from './browser-profile-site-list'

function allowed(entries: string[], url: string): boolean {
  return isUrlAllowedBySiteList(compileBrowserSiteList(entries), url)
}

describe('browser profile site list', () => {
  it('matches an exact host or wildcard subdomains, never the apex or a look-alike', () => {
    expect(allowed(['example.com'], 'https://example.com./a?b=1')).toBe(true)
    expect(allowed(['example.com'], 'https://www.example.com/')).toBe(false)
    expect(allowed(['*.example.com'], 'https://a.b.example.com/')).toBe(true)
    expect(allowed(['*.example.com'], 'https://example.com/')).toBe(false)
    expect(allowed(['*.example.com'], 'https://evilexample.com/')).toBe(false)
    expect(allowed(['xn--bcher-kva.de'], 'https://BÜCHER.de/')).toBe(true)
  })

  it('blocks file:, ftp: and IP literals but leaves non-network schemes alone', () => {
    expect(allowed(['example.com'], 'file:///etc/hosts')).toBe(false)
    expect(allowed(['example.com'], 'ftp://example.com/')).toBe(false)
    expect(allowed(['example.com'], 'http://93.184.216.34/')).toBe(false)
    expect(allowed(['example.com'], 'http://[::1]/')).toBe(false)
    expect(allowed(['example.com'], 'data:text/plain,hi')).toBe(true)
  })

  it('rejects top-level domains, IPs, ports and paths', () => {
    expect(normalizeBrowserSiteListEntry('LocalHost')).toBe('localhost')
    expect(normalizeBrowserSiteListEntries(['Example.COM', 'example.com'])).toEqual({
      ok: true,
      entries: ['example.com']
    })
    for (const entry of ['com', '*.com', '*.localhost', '127.1', 'a.com:80', 'a.com/x', 'a..com']) {
      expect(normalizeBrowserSiteListEntries(['b.com', entry])).toEqual({
        ok: false,
        invalid: entry
      })
    }
  })

  it('treats only entries the list already admits as not widening', () => {
    const list = compileBrowserSiteList(['example.com', '*.docs.example.com'])
    expect(isSiteListEntryCovered(list, 'a.docs.example.com')).toBe(true)
    expect(isSiteListEntryCovered(list, '*.api.docs.example.com')).toBe(true)
    expect(isSiteListEntryCovered(list, 'www.example.com')).toBe(false)
    expect(isSiteListEntryCovered(list, '*.example.com')).toBe(false)
  })
})
