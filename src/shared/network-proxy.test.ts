import { describe, expect, it } from 'vitest'
import {
  buildConfiguredProxyEnv,
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  normalizeProxyBypassRules,
  normalizeProxyCaPath,
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

  describe('proxy CA path', () => {
    it('accepts an absolute posix or windows path and trims it', () => {
      expect(normalizeProxyCaPath('  /etc/ssl/certs/proxy-ca.pem ')).toEqual({
        ok: true,
        value: '/etc/ssl/certs/proxy-ca.pem'
      })
      expect(normalizeProxyCaPath('C:\\certs\\proxy-ca.pem').ok).toBe(true)
      expect(normalizeProxyCaPath('\\\\fileserver\\certs\\ca.pem').ok).toBe(true)
    })

    it('treats empty and non-string values as unset rather than invalid', () => {
      expect(normalizeProxyCaPath('')).toEqual({ ok: true, value: '' })
      expect(normalizeProxyCaPath('   ')).toEqual({ ok: true, value: '' })
      expect(normalizeProxyCaPath(undefined)).toEqual({ ok: true, value: '' })
      expect(normalizeProxyCaPath(null)).toEqual({ ok: true, value: '' })
    })

    it('rejects a relative path', () => {
      // Agent CLIs are spawned with their own working directories, so a relative
      // path would resolve differently for each of them.
      const result = normalizeProxyCaPath('certs/proxy-ca.pem')
      expect(result.ok).toBe(false)
      expect(result.value).toBe('')
    })

    it('rejects an absurdly long path', () => {
      expect(normalizeProxyCaPath(`/${'a'.repeat(5000)}`).ok).toBe(false)
    })
  })

  describe('configured proxy environment', () => {
    it('exports the CA to spawned agents as NODE_EXTRA_CA_CERTS', () => {
      const env = buildConfiguredProxyEnv({
        httpProxyUrl: 'http://127.0.0.1:8790',
        httpProxyCaPath: '/etc/ssl/certs/proxy-ca.pem'
      })
      expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/proxy-ca.pem')
      expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:8790')
    })

    it('omits NODE_EXTRA_CA_CERTS when no CA is configured', () => {
      const env = buildConfiguredProxyEnv({ httpProxyUrl: 'http://127.0.0.1:8790' })
      expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
    })

    it('keeps bypass rules reaching agents as NO_PROXY', () => {
      // Load-bearing for split-DNS overlays such as Tailscale: those hosts must
      // resolve and connect directly, never through the proxy.
      const env = buildConfiguredProxyEnv({
        httpProxyUrl: 'http://127.0.0.1:8790',
        httpProxyBypassRules: '127.0.0.1;*.ts.net;internal.example.com'
      })
      expect(env.NO_PROXY).toBe('127.0.0.1,*.ts.net,internal.example.com')
      expect(env.no_proxy).toBe(env.NO_PROXY)
    })
  })
})
