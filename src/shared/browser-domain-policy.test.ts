import { describe, expect, it } from 'vitest'
import { isBrowserNetworkUrlAllowed, normalizeBrowserAllowedDomains } from './browser-domain-policy'

describe('browser domain policy', () => {
  it('normalizes exact and wildcard domains', () => {
    expect(
      normalizeBrowserAllowedDomains(['LOCALHOST', '127.0.0.1', '*.Storika.AI', 'localhost'])
    ).toEqual(['localhost', '127.0.0.1', '*.storika.ai'])
  })

  it('rejects invalid or authority-bearing domain entries', () => {
    for (const value of [
      '',
      'https://example.com',
      'user@example.com',
      'example.com:443',
      '*',
      '*.localhost',
      'example..com'
    ]) {
      expect(() => normalizeBrowserAllowedDomains([value])).toThrow()
    }
  })

  it('allows only matching network hosts and safe document bootstrap schemes', () => {
    const policy = normalizeBrowserAllowedDomains(['localhost', '127.0.0.1', '*.storika.ai'])

    for (const url of [
      'http://localhost:3101/login',
      'ws://127.0.0.1:3100/socket',
      'https://app-dev.storika.ai/brands',
      'wss://api-dev.storika.ai/events',
      'about:blank',
      'data:text/html,'
    ]) {
      expect(isBrowserNetworkUrlAllowed(url, policy)).toBe(true)
    }

    for (const url of [
      'https://example.com',
      'https://storika.ai.evil.example',
      'https://storika.ai',
      'file:///etc/passwd',
      'ftp://app-dev.storika.ai/file',
      'javascript:location="https://example.com"'
    ]) {
      expect(isBrowserNetworkUrlAllowed(url, policy)).toBe(false)
    }
  })
})
