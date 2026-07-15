import { describe, expect, it } from 'vitest'
import {
  browserCookieDomainMatchesScope,
  deriveBrowserCookieDomainsFromHomeUrl,
  isGoogleCookieImportScope,
  normalizeBrowserCookieDomain,
  normalizeBrowserCookieImportScope,
  normalizeBrowserCookieImportScopeForHome
} from './browser-cookie-import-scope'

describe('browser cookie import scope', () => {
  it('derives the shared Google scope for AI Studio', () => {
    expect(deriveBrowserCookieDomainsFromHomeUrl('https://aistudio.google.com/prompts')).toEqual([
      'google.com'
    ])
    expect(
      normalizeBrowserCookieImportScopeForHome(
        { label: 'Google AI Studio', domains: [] },
        'https://aistudio.google.com/'
      )
    ).toEqual({
      label: 'Google AI Studio',
      domains: ['google.com'],
      sourceHostname: 'aistudio.google.com'
    })
  })

  it('normalizes and de-duplicates a custom domain scope', () => {
    expect(
      normalizeBrowserCookieImportScopeForHome(
        { label: '  Internal   AI  ', domains: ['.Example.COM', 'example.com'] },
        'https://chat.example.com/'
      )
    ).toEqual({
      label: 'Internal AI',
      domains: ['example.com'],
      sourceHostname: 'chat.example.com'
    })
    expect(normalizeBrowserCookieDomain('.Accounts.Example.COM.')).toBe('accounts.example.com')
  })

  it('rejects non-HTTPS homes, unrelated domains, wildcards, and public suffixes', () => {
    expect(
      normalizeBrowserCookieImportScopeForHome(
        { label: 'Example', domains: ['example.com'] },
        'http://chat.example.com/'
      )
    ).toBeNull()
    expect(
      normalizeBrowserCookieImportScopeForHome(
        { label: 'Example', domains: ['unrelated.com'] },
        'https://chat.example.com/'
      )
    ).toBeNull()
    expect(
      normalizeBrowserCookieImportScope({
        label: 'Example',
        domains: ['*.example.com'],
        sourceHostname: 'chat.example.com'
      })
    ).toBe(null)
    expect(
      normalizeBrowserCookieImportScope({
        label: 'Example',
        domains: ['co.uk'],
        sourceHostname: 'chat.example.co.uk'
      })
    ).toBeNull()
    expect(
      normalizeBrowserCookieImportScope({
        label: 'Example',
        domains: ['github.io'],
        sourceHostname: 'app.github.io'
      })
    ).toBeNull()
    expect(
      normalizeBrowserCookieImportScope({
        label: 'Example',
        domains: ['example.com/path'],
        sourceHostname: 'chat.example.com'
      })
    ).toBeNull()
    expect(
      normalizeBrowserCookieImportScope({
        label: 'Example',
        domains: ['foo_bar.example.com'],
        sourceHostname: 'foo_bar.example.com'
      })
    ).toBeNull()
    expect(
      normalizeBrowserCookieImportScope({
        label: 'Example',
        domains: ['127.0.0.1'],
        sourceHostname: '127.0.0.1'
      })
    ).toBeNull()
  })

  it('caps renderer-supplied labels, domains, and domain counts', () => {
    expect(
      normalizeBrowserCookieImportScope({
        label: 'x'.repeat(81),
        domains: ['example.com'],
        sourceHostname: 'chat.example.com'
      })
    ).toBeNull()
    expect(
      normalizeBrowserCookieImportScope({
        label: 'Example',
        domains: Array.from({ length: 17 }, () => 'example.com'),
        sourceHostname: 'chat.example.com'
      })
    ).toBeNull()
    expect(
      normalizeBrowserCookieImportScope({
        label: 'Example',
        domains: [`${'a'.repeat(244)}.example.com`],
        sourceHostname: 'chat.example.com'
      })
    ).toBeNull()
  })

  it('matches suffixes without matching lookalike domains', () => {
    const scope = { label: 'Example AI', domains: ['example.com'] }
    expect(browserCookieDomainMatchesScope('.example.com', scope)).toBe(true)
    expect(browserCookieDomainMatchesScope('auth.example.com', scope)).toBe(true)
    expect(browserCookieDomainMatchesScope('notexample.com', scope)).toBe(false)
  })

  it('identifies Google scopes for shared-login warnings', () => {
    expect(isGoogleCookieImportScope({ domains: ['google.com'] })).toBe(true)
    expect(isGoogleCookieImportScope({ domains: ['example.com'] })).toBe(false)
  })
})
