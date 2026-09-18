import { describe, expect, it } from 'vitest'
import { classifyHostUrl } from './tab-create-entry-url-classification'

// Why this file exists: the suffix check behind `host/path` navigation moved off `psl.isValid`, and
// nothing else in the tree exercises it directly. These cases pin the listed/unlisted split that
// decides whether a typed string navigates or falls through to search.
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

  // The PRIVATE section has to stay in: these are navigable hosts, not search terms.
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

  // Why this is the fix: psl's 2024 snapshot did not know `api.br`, so `isValid` called it a domain
  // and a typed `api.br/x` navigated to a bare public suffix instead of searching.
  it('refuses a bare public suffix carrying a path', () => {
    expect(classifyHostUrl('api.br/foo')).toBeNull()
    expect(classifyHostUrl('co.uk/foo')).toBeNull()
    expect(classifyHostUrl('github.io/foo')).toBeNull()
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

  // The gate only applies once an authority ends; a bare host still navigates so unlisted intranet
  // names typed on their own are not forced into search.
  it('leaves a bare host unfiltered by the suffix list', () => {
    expect(classifyHostUrl('api.br')).toEqual({ kind: 'host-url', url: 'https://api.br/' })
  })
})
