import { describe, expect, it } from 'vitest'

import {
  compileBrowserSiteList,
  isSiteListEntryCovered,
  isUrlAllowedBySiteList,
  normalizeBrowserSiteListEntry,
  parseBrowserSiteList
} from './browser-profile-site-list'

function allowed(entries: string[], url: string): boolean {
  const parsed = parseBrowserSiteList(entries.join('\n'))
  if (!parsed.ok) {
    throw new Error('test list must be valid')
  }
  return isUrlAllowedBySiteList(compileBrowserSiteList(parsed.entries), url)
}

describe('parseBrowserSiteList', () => {
  it('normalizes case, punycode and duplicates, and skips blank lines', () => {
    const text = 'Example.COM\n\n*.Docs.Example.com\r\nbücher.de\nexample.com'
    expect(parseBrowserSiteList(text)).toEqual({
      ok: true,
      entries: ['example.com', '*.docs.example.com', 'xn--bcher-kva.de']
    })
  })

  it.each([
    ['10.0.0.1', 'ip-address'],
    ['127.1', 'ip-address'],
    ['[::1]', 'port-path-or-scheme'],
    ['example.com:8080', 'port-path-or-scheme'],
    ['example.com/path', 'port-path-or-scheme'],
    ['https://example.com', 'port-path-or-scheme'],
    ['user@example.com', 'port-path-or-scheme'],
    ['example..com', 'invalid'],
    ['example.com.', 'invalid'],
    ['*.*.example.com', 'invalid'],
    ['exa*mple.com', 'invalid'],
    ['*.', 'invalid'],
    ['com', 'single-label'],
    ['*.com', 'single-label'],
    ['*.localhost', 'single-label'],
    ['intranet', 'single-label']
  ])('rejects %s', (entry, error) => {
    expect(normalizeBrowserSiteListEntry(entry)).toEqual({ ok: false, error })
  })

  it('reports the failing line and the entry cap', () => {
    expect(parseBrowserSiteList('a.com\n\nb.com:1')).toEqual({
      ok: false,
      error: 'port-path-or-scheme',
      line: 3
    })
    const tooMany = Array.from({ length: 257 }, (_, i) => `h${i}.example.com`).join('\n')
    expect(parseBrowserSiteList(tooMany)).toEqual({ ok: false, error: 'too-many' })
  })
})

describe('single-label entries', () => {
  it('allows only exact localhost', () => {
    expect(normalizeBrowserSiteListEntry('LocalHost')).toEqual({ ok: true, entry: 'localhost' })
    expect(allowed(['localhost'], 'http://localhost:3000/')).toBe(true)
    expect(allowed(['localhost'], 'http://app.localhost/')).toBe(false)
  })

  it('never lets a top-level domain admit every host under it', () => {
    expect(parseBrowserSiteList('*.com')).toEqual({ ok: false, error: 'single-label', line: 1 })
    expect(parseBrowserSiteList('example.com\ncom')).toEqual({
      ok: false,
      error: 'single-label',
      line: 2
    })
  })
})

describe('isUrlAllowedBySiteList', () => {
  it('matches an exact host but not its subdomains', () => {
    expect(allowed(['example.com'], 'https://example.com/a?b=1')).toBe(true)
    expect(allowed(['example.com'], 'https://www.example.com/')).toBe(false)
    expect(allowed(['example.com'], 'https://notexample.com/')).toBe(false)
  })

  it('lets *.host match subdomains at any depth but not the apex', () => {
    expect(allowed(['*.example.com'], 'https://a.b.example.com/')).toBe(true)
    expect(allowed(['*.example.com'], 'https://example.com/')).toBe(false)
    expect(allowed(['*.example.com'], 'https://evilexample.com/')).toBe(false)
    expect(allowed(['example.com', '*.example.com'], 'https://example.com/')).toBe(true)
  })

  it('applies to http, https, ws and wss and ignores the port', () => {
    const list = ['example.com']
    expect(allowed(list, 'http://example.com:3000/')).toBe(true)
    expect(allowed(list, 'wss://example.com/socket')).toBe(true)
    expect(allowed(list, 'ws://other.com/socket')).toBe(false)
  })

  it('matches IDN hosts and a trailing dot', () => {
    expect(allowed(['bücher.de'], 'https://BÜCHER.de/')).toBe(true)
    expect(allowed(['example.com'], 'https://example.com./')).toBe(true)
  })

  it('blocks IP literals', () => {
    expect(allowed(['example.com'], 'http://93.184.216.34/')).toBe(false)
    expect(allowed(['example.com'], 'http://[::1]/')).toBe(false)
  })

  it('leaves non-network schemes alone but blocks file: and ftp:', () => {
    const list = ['example.com']
    expect(allowed(list, 'data:text/plain,hi')).toBe(true)
    expect(allowed(list, 'blob:https://other.com/1234')).toBe(true)
    expect(allowed(list, 'about:blank')).toBe(true)
    expect(allowed(list, 'devtools://devtools/bundled/inspector.html')).toBe(true)
    expect(allowed(list, 'chrome-extension://abcdefgh/page.html')).toBe(true)
    expect(allowed(list, 'file:///etc/hosts')).toBe(false)
    expect(allowed(list, 'ftp://example.com/')).toBe(false)
  })
})

describe('isSiteListEntryCovered', () => {
  const list = compileBrowserSiteList(['example.com', '*.docs.example.com'])

  it('treats entries the list already admits as not widening', () => {
    expect(isSiteListEntryCovered(list, 'example.com')).toBe(true)
    expect(isSiteListEntryCovered(list, 'a.docs.example.com')).toBe(true)
    expect(isSiteListEntryCovered(list, '*.docs.example.com')).toBe(true)
    expect(isSiteListEntryCovered(list, '*.api.docs.example.com')).toBe(true)
  })

  it('treats entries that admit more hosts as widening', () => {
    expect(isSiteListEntryCovered(list, 'www.example.com')).toBe(false)
    expect(isSiteListEntryCovered(list, '*.example.com')).toBe(false)
    expect(isSiteListEntryCovered(list, '*.docs.example.com.evil.net')).toBe(false)
    expect(isSiteListEntryCovered(list, 'docs.example.com')).toBe(false)
  })
})
