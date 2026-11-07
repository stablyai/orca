import { describe, expect, it } from 'vitest'
import { isAbsoluteBrowserUrl } from './browser-expected-url'

describe('expected browser URL rule', () => {
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
