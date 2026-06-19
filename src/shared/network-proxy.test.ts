import { describe, expect, it } from 'vitest'
import {
  buildConfiguredProxyEnv,
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  normalizeProxyBypassRules,
  normalizeProxyUrl,
  redactProxyUrl
} from './network-proxy'

describe('network proxy settings', () => {
  it('normalizes supported proxy URLs without path, query, or fragment', () => {
    expect(normalizeProxyUrl(' https://user:pass@proxy.example.com:8443/path?q=1#secret ')).toEqual(
      {
        ok: true,
        value: 'https://user:pass@proxy.example.com:8443'
      }
    )
  })

  it('rejects unsupported or malformed proxy URLs', () => {
    expect(normalizeProxyUrl('file:///tmp/proxy').ok).toBe(false)
    expect(normalizeProxyUrl('http://').ok).toBe(false)
    expect(normalizeProxyUrl('not-a-url').ok).toBe(false)
  })

  it('normalizes bypass rules from common separator styles', () => {
    expect(normalizeProxyBypassRules('localhost, 127.0.0.1; *.internal\n<local>')).toBe(
      'localhost;127.0.0.1;*.internal;<local>'
    )
  })

  it('uses standard proxy environment precedence', () => {
    expect(
      getProxyUrlFromEnvironment({
        HTTP_PROXY: 'http://plain.example:8080',
        HTTPS_PROXY: 'https://secure.example:8443'
      })
    ).toEqual({ ok: true, value: 'https://secure.example:8443' })
    expect(
      getProxyBypassRulesFromEnvironment({
        no_proxy: 'localhost,*.internal'
      })
    ).toBe('localhost;*.internal')
  })

  it('builds local PTY proxy env only from explicit settings', () => {
    expect(
      buildConfiguredProxyEnv({
        httpProxyUrl: 'http://proxy.example:8080',
        httpProxyBypassRules: 'localhost;*.internal'
      })
    ).toEqual({
      HTTP_PROXY: 'http://proxy.example:8080',
      HTTPS_PROXY: 'http://proxy.example:8080',
      ALL_PROXY: 'http://proxy.example:8080',
      http_proxy: 'http://proxy.example:8080',
      https_proxy: 'http://proxy.example:8080',
      all_proxy: 'http://proxy.example:8080',
      NO_PROXY: 'localhost,*.internal',
      no_proxy: 'localhost,*.internal'
    })
    expect(buildConfiguredProxyEnv({ httpProxyUrl: '' })).toEqual({})
  })

  it('redacts credentials for diagnostics', () => {
    expect(redactProxyUrl('http://user:pass@proxy.example:8080')).toBe(
      'http://***:***@proxy.example:8080'
    )
  })
})
