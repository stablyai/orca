import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isEligibleLocalCertificateHost,
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from './browser-url'

describe('browser-url helpers', () => {
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

  it('rejects non-web schemes for in-app navigation', () => {
    expect(normalizeBrowserNavigationUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeExternalBrowserUrl('about:blank')).toBeNull()
  })

  describe('file path backslashes', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('preserves backslashes as filename characters on POSIX hosts', () => {
      vi.stubGlobal('navigator', { userAgent: 'Linux' })
      expect(normalizeBrowserNavigationUrl('/tmp/site\\draft.html')).toBe(
        'file:///tmp/site%5Cdraft.html'
      )
    })

    it('normalizes backslashes to separators on Windows hosts', () => {
      vi.stubGlobal('navigator', { userAgent: 'Windows' })
      expect(normalizeBrowserNavigationUrl('/foo\\bar.html')).toBe('file:///foo/bar.html')
      expect(normalizeBrowserNavigationUrl('C:\\site\\draft.html')).toBe(
        'file:///C:/site/draft.html'
      )
      expect(normalizeBrowserNavigationUrl('\\\\server\\share\\draft.html')).toBe(
        'file://server/share/draft.html'
      )
    })
  })

  // Refuse file URLs externally: a remote page must not drive Finder/Explorer to arbitrary paths.
  it('rejects file:// for external opens even though it is allowed in-app', () => {
    expect(normalizeExternalBrowserUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeExternalBrowserUrl('\\\\server\\share\\Example.ipynb')).toBeNull()
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
