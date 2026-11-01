import { describe, expect, it } from 'vitest'
import { classifyHostUrl } from './tab-create-entry-url-classification'

// Pin suffix-list navigation behavior directly instead of relying on classifier composition tests.
describe('classifyHostUrl suffix gate', () => {
  it('navigates for a listed suffix carrying a path', () => {
    expect(classifyHostUrl('example.com/foo')).toEqual({
      kind: 'host-url',
      url: 'https://example.com/foo'
    })
    expect(classifyHostUrl('example.co.uk/foo')).toEqual({
      kind: 'host-url',
      url: 'https://example.co.uk/foo'
    })
  })

  it('navigates for a private-section suffix carrying a path', () => {
    expect(classifyHostUrl('foo.github.io/bar')).toEqual({
      kind: 'host-url',
      url: 'https://foo.github.io/bar'
    })
    expect(classifyHostUrl('foo.vercel.app/bar')).toEqual({
      kind: 'host-url',
      url: 'https://foo.vercel.app/bar'
    })
  })

  it.each(['github.io', 'blogspot.com', 'readthedocs.io', 'vercel.app'])(
    'navigates to the hosting-provider domain %s itself',
    (host) => {
      expect(classifyHostUrl(host, { requireListedDomain: true })).toEqual({
        kind: 'host-url',
        url: `https://${host}/`
      })
      expect(classifyHostUrl(`${host}/foo`)).toEqual({
        kind: 'host-url',
        url: `https://${host}/foo`
      })
    }
  )

  // api.br is a public suffix missing from the old psl snapshot; a suffix alone cannot name a registrable destination.
  it('refuses a bare public suffix carrying a path', () => {
    expect(classifyHostUrl('api.br/foo')).toBeNull()
    expect(classifyHostUrl('co.uk/foo')).toBeNull()
  })

  it('keeps localhost and IPv4 on http without consulting the suffix list', () => {
    expect(classifyHostUrl('localhost:3000/foo')).toEqual({
      kind: 'host-url',
      url: 'http://localhost:3000/foo'
    })
    expect(classifyHostUrl('127.0.0.1:8080/foo')).toEqual({
      kind: 'host-url',
      url: 'http://127.0.0.1:8080/foo'
    })
  })

  // Bare hosts bypass suffix filtering so intranet names still navigate.
  it('leaves a bare host unfiltered by the suffix list', () => {
    expect(classifyHostUrl('api.br')).toEqual({ kind: 'host-url', url: 'https://api.br/' })
  })
})
