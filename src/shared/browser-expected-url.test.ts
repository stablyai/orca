import { describe, expect, it } from 'vitest'
import { isAbsoluteBrowserUrl, isSameBrowserUrl } from './browser-expected-url'

describe('expected browser URL rule', () => {
  it.each([
    ['https://example.com', 'https://EXAMPLE.com/'],
    ['https://example.com:443/a', 'https://example.com/a'],
    ['https://example.com/a b', 'https://example.com/a%20b']
  ])('treats %s and %s as one URL', (left, right) => {
    expect(isSameBrowserUrl(left, right)).toBe(true)
  })

  it.each([
    ['another route', 'https://example.com/chat/a', 'https://example.com/chat/b'],
    ['another query', 'https://example.com/chat?id=a', 'https://example.com/chat?id=b'],
    ['another fragment', 'https://example.com/#/chat/a', 'https://example.com/#/chat/b'],
    ['an added fragment', 'https://example.com/a', 'https://example.com/a#m'],
    ['a trailing slash', 'https://example.com/a', 'https://example.com/a/'],
    ['reordered query', 'https://example.com/?a=1&b=2', 'https://example.com/?b=2&a=1'],
    ['another origin', 'https://example.com/a', 'https://example.org/a'],
    ['an empty guest URL', 'https://example.com/a', '']
  ])('tells apart %s', (_label, left, right) => {
    expect(isSameBrowserUrl(left, right)).toBe(false)
  })

  it.each([
    ['https://example.com/chat/a', true],
    ['about:blank', true],
    ['data:text/html,', true],
    ['/chat/a', false],
    ['example.com/chat/a', false],
    ['localhost:3000/chat/a', false],
    ['example.com:8080/chat/a', false],
    [`https://example.com/${'a'.repeat(8192)}`, false]
  ])('accepts %s as an expected URL: %s', (raw, accepted) => {
    expect(isAbsoluteBrowserUrl(raw)).toBe(accepted)
  })
})
