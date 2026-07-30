import { describe, expect, it } from 'vitest'
import { ORCA_BROWSER_BLANK_URL } from './constants'
import {
  buildSearchUrl,
  classifySchemeLessLocalDevAddress,
  isEligibleLocalCertificateHost,
  normalizeKagiSessionLink,
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken,
  resolveRemoteFailureExternalUrl,
  toSecureCertificateEndpoint,
  toHttpsRecoveryUrl
} from './browser-url'

describe('browser-url helpers', () => {
  it('normalizes manual local-dev inputs to http', () => {
    expect(normalizeBrowserNavigationUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeBrowserNavigationUrl('127.0.0.1:5173')).toBe('http://127.0.0.1:5173/')
    expect(normalizeBrowserNavigationUrl('localhost:3000?debug=1')).toBe(
      'http://localhost:3000/?debug=1'
    )
    expect(normalizeBrowserNavigationUrl('localhost:3000#preview')).toBe(
      'http://localhost:3000/#preview'
    )
  })

  it('keeps the legacy scheme-less local-dev classifier broader than certificate eligibility', () => {
    for (const input of [
      'localhost:3000/path',
      '127.0.0.1:5173',
      '0.0.0.0:8080',
      '[::1]:3000',
      '[2001:db8::1]:3000'
    ]) {
      expect(classifySchemeLessLocalDevAddress(input), input).not.toBeNull()
    }
    expect(classifySchemeLessLocalDevAddress('app.localhost:3000')).toBeNull()
    expect(isEligibleLocalCertificateHost('0.0.0.0')).toBe(false)
    expect(isEligibleLocalCertificateHost('[2001:db8::1]')).toBe(false)
  })

  it('recognizes only canonical loopback certificate hosts', () => {
    for (const hostname of [
      'localhost',
      'LOCALHOST.',
      'app.localhost',
      'deep.app.localhost.',
      '127.0.0.1',
      '127.255.255.255',
      '::1',
      '[::1]'
    ]) {
      expect(isEligibleLocalCertificateHost(hostname), hostname).toBe(true)
    }
    for (const hostname of [
      '0.0.0.0',
      '::',
      '[2001:db8::1]',
      '192.168.1.1',
      'localhost.example.com',
      'notlocalhost',
      '.localhost',
      '-bad.localhost',
      'bad-.localhost',
      '127.0.0.999',
      '127.00.0.1'
    ]) {
      expect(isEligibleLocalCertificateHost(hostname), hostname).toBe(false)
    }
  })

  it('constructs HTTPS recovery URLs without changing the rest of the address', () => {
    expect(toHttpsRecoveryUrl('http://localhost:3000/path?q=1#preview')).toBe(
      'https://localhost:3000/path?q=1#preview'
    )
    expect(toHttpsRecoveryUrl('http://user:pass@127.0.0.2:8080/')).toBe(
      'https://user:pass@127.0.0.2:8080/'
    )
    expect(toHttpsRecoveryUrl('http://localhost:80/path')).toBe('https://localhost/path')
    expect(toHttpsRecoveryUrl('https://localhost:3000/')).toBeNull()
    expect(toHttpsRecoveryUrl('http://0.0.0.0:3000/')).toBeNull()
    expect(toHttpsRecoveryUrl('http://example.com/')).toBeNull()
    expect(toHttpsRecoveryUrl('not a url')).toBeNull()
  })

  it('canonicalizes secure certificate endpoints without path or credential data', () => {
    expect(toSecureCertificateEndpoint('https://User:secret@LOCALHOST.:443/path?q=1')).toBe(
      'https://localhost:443'
    )
    expect(toSecureCertificateEndpoint('wss://localhost:3000/socket')).toBe(
      'https://localhost:3000'
    )
    expect(toSecureCertificateEndpoint('https://[::1]/')).toBe('https://[::1]:443')
    expect(toSecureCertificateEndpoint('http://localhost:3000/')).toBeNull()
    expect(toSecureCertificateEndpoint('not a url')).toBeNull()
  })

  it('offers Open Externally for a remote failure only when the URL is desktop-reachable', () => {
    // Loopback / wildcard hosts are unreachable from the desktop system browser.
    expect(resolveRemoteFailureExternalUrl('https://localhost:3000/')).toBeNull()
    expect(resolveRemoteFailureExternalUrl('https://127.0.0.1:3000/')).toBeNull()
    expect(resolveRemoteFailureExternalUrl('https://127.0.0.9:3000/')).toBeNull()
    expect(resolveRemoteFailureExternalUrl('https://[::1]:3000/')).toBeNull()
    expect(resolveRemoteFailureExternalUrl('https://app.localhost:3000/')).toBeNull()
    expect(resolveRemoteFailureExternalUrl('http://0.0.0.0:3000/')).toBeNull()
    expect(resolveRemoteFailureExternalUrl('http://[::]:3000/')).toBeNull()
    // Public hosts are reachable, so the action is offered.
    expect(resolveRemoteFailureExternalUrl('https://example.com/app')).toBe(
      'https://example.com/app'
    )
    expect(resolveRemoteFailureExternalUrl('http://example.com:8080/x')).toBe(
      'http://example.com:8080/x'
    )
    // Non-web schemes and garbage never become an external target.
    expect(resolveRemoteFailureExternalUrl('file:///etc/passwd')).toBeNull()
    expect(resolveRemoteFailureExternalUrl('not a url')).toBeNull()
  })

  it('keeps normal web URLs and blank tabs in the allowed set', () => {
    expect(normalizeBrowserNavigationUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeBrowserNavigationUrl('')).toBe(ORCA_BROWSER_BLANK_URL)
    expect(normalizeBrowserNavigationUrl('about:blank')).toBe(ORCA_BROWSER_BLANK_URL)
  })

  it('rejects non-web schemes for in-app navigation', () => {
    expect(normalizeBrowserNavigationUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeExternalBrowserUrl('about:blank')).toBeNull()
  })

  // Why: "Open Preview to the Side" on an HTML file loads the file via file://
  // in the browser pane. The guest webview is sandboxed (see
  // createMainWindow.ts will-attach-webview), so rendering local HTML cannot
  // escalate privileges beyond what the editor already grants.
  it('allows file:// URLs so local HTML can be previewed', () => {
    expect(normalizeBrowserNavigationUrl('file:///Users/me/site/index.html')).toBe(
      'file:///Users/me/site/index.html'
    )
  })

  it('normalizes pasted absolute local paths to file URLs', () => {
    expect(normalizeBrowserNavigationUrl('/Users/me/Downloads/Example.ipynb')).toBe(
      'file:///Users/me/Downloads/Example.ipynb'
    )
    expect(normalizeBrowserNavigationUrl('C:\\Users\\me\\Downloads\\Example.ipynb')).toBe(
      'file:///C:/Users/me/Downloads/Example.ipynb'
    )
    expect(normalizeBrowserNavigationUrl('\\\\server\\share\\Example.ipynb')).toBe(
      'file://server/share/Example.ipynb'
    )
    expect(
      normalizeBrowserNavigationUrl('\\\\wsl.localhost\\Ubuntu\\home\\me\\Example.ipynb')
    ).toBe('file://wsl.localhost/Ubuntu/home/me/Example.ipynb')
  })

  it('normalizes absolute local paths with spaces and reserved URL characters', () => {
    expect(normalizeBrowserNavigationUrl('/Users/me/My Site/index #1.html')).toBe(
      'file:///Users/me/My%20Site/index%20%231.html'
    )
    expect(normalizeBrowserNavigationUrl('C:\\Users\\me\\My Site\\index #1.html')).toBe(
      'file:///C:/Users/me/My%20Site/index%20%231.html'
    )
    expect(normalizeBrowserNavigationUrl('C:\\tmp\\orca & 100% ! ^\\index.html')).toBe(
      'file:///C:/tmp/orca%20%26%20100%25%20!%20%5E/index.html'
    )
  })

  // Why: in-app preview is fine (sandboxed webview), but handing file:// to
  // shell.openExternal would let a remote page drive Finder/Explorer to
  // arbitrary paths. External-open paths must still refuse file://.
  it('rejects file:// for external opens even though it is allowed in-app', () => {
    expect(normalizeExternalBrowserUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeExternalBrowserUrl('\\\\server\\share\\Example.ipynb')).toBeNull()
  })

  it('returns null for non-URL input without search engine opt-in', () => {
    expect(normalizeBrowserNavigationUrl('not a url')).toBeNull()
  })

  it('attempts https:// prefix for bare words without search opt-in', () => {
    expect(normalizeBrowserNavigationUrl('singleword')).toBe('https://singleword/')
  })

  it('treats bare words and multi-word input as search queries when search is enabled', () => {
    expect(normalizeBrowserNavigationUrl('react hooks', null)).toBe(
      'https://www.google.com/search?q=react%20hooks'
    )
    expect(normalizeBrowserNavigationUrl('what is typescript', null)).toBe(
      'https://www.google.com/search?q=what%20is%20typescript'
    )
    expect(normalizeBrowserNavigationUrl('singleword', null)).toBe(
      'https://www.google.com/search?q=singleword'
    )
  })

  it('respects the search engine parameter', () => {
    expect(normalizeBrowserNavigationUrl('react hooks', 'duckduckgo')).toBe(
      'https://duckduckgo.com/?q=react%20hooks'
    )
    expect(normalizeBrowserNavigationUrl('react hooks', 'bing')).toBe(
      'https://www.bing.com/search?q=react%20hooks'
    )
    expect(normalizeBrowserNavigationUrl('react hooks', 'kagi')).toBe(
      'https://kagi.com/search?q=react%20hooks'
    )
  })

  it('treats domain-like inputs as URLs, not searches', () => {
    expect(normalizeBrowserNavigationUrl('example.com', null)).toBe('https://example.com/')
    expect(normalizeBrowserNavigationUrl('github.com/org/repo', null)).toBe(
      'https://github.com/org/repo'
    )
  })

  it('builds search URLs correctly', () => {
    expect(buildSearchUrl('hello world', 'google')).toBe(
      'https://www.google.com/search?q=hello%20world'
    )
    expect(buildSearchUrl('hello world', 'duckduckgo')).toBe(
      'https://duckduckgo.com/?q=hello%20world'
    )
    expect(buildSearchUrl('hello world', 'kagi')).toBe('https://kagi.com/search?q=hello%20world')
  })

  it('uses a Kagi private session link when configured', () => {
    const sessionLink = 'https://kagi.com/search?token=secret&q=%s#ignored'
    expect(normalizeKagiSessionLink(sessionLink)).toBe('https://kagi.com/search?token=secret')
    expect(
      buildSearchUrl('hello world', 'kagi', {
        kagiSessionLink: sessionLink
      })
    ).toBe('https://kagi.com/search?token=secret&q=hello+world')
    expect(
      normalizeBrowserNavigationUrl('hello world', 'kagi', {
        kagiSessionLink: sessionLink
      })
    ).toBe('https://kagi.com/search?token=secret&q=hello+world')
  })

  it('rejects invalid Kagi private session links', () => {
    expect(normalizeKagiSessionLink('https://kagi.com/search?q=%s')).toBeNull()
    expect(normalizeKagiSessionLink('http://kagi.com/search?token=secret')).toBeNull()
    expect(normalizeKagiSessionLink('https://example.com/search?token=secret')).toBeNull()
    expect(normalizeKagiSessionLink('https://user:pass@kagi.com/search?token=secret')).toBeNull()
    expect(normalizeKagiSessionLink('https://kagi.com:8443/search?token=secret')).toBeNull()
  })

  it('accepts kagi.com/search/ with trailing slash', () => {
    expect(normalizeKagiSessionLink('https://kagi.com/search/?token=secret')).toBe(
      'https://kagi.com/search/?token=secret'
    )
  })

  it('collapses duplicate token params in Kagi private session links', () => {
    expect(normalizeKagiSessionLink('https://kagi.com/search?token=A&token=B')).toBe(
      'https://kagi.com/search?token=A'
    )
  })

  it('redacts Kagi private session tokens from displayable URLs', () => {
    expect(redactKagiSessionToken('https://kagi.com/search?token=secret&q=hello+world')).toBe(
      'https://kagi.com/search?q=hello+world'
    )
    expect(redactKagiSessionToken('https://kagi.com/search?q=hello+world')).toBe(
      'https://kagi.com/search?q=hello+world'
    )
    expect(redactKagiSessionToken('https://kagi.com/search/?token=secret&q=hi')).toBe(
      'https://kagi.com/search/?q=hi'
    )
  })
})
