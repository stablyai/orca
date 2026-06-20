import { describe, expect, it } from 'vitest'
import { hostnameFromOrigin, normalizeCredentialOrigin } from './browser-credential-hostname'

describe('normalizeCredentialOrigin', () => {
  it('reduces a full URL to scheme://host (lowercased, no path/port)', () => {
    expect(normalizeCredentialOrigin('https://GitHub.com:443/login?x=1')).toBe('https://github.com')
  })

  it('keeps http scheme distinct from https', () => {
    expect(normalizeCredentialOrigin('http://example.com/a')).toBe('http://example.com')
  })

  it('rejects non-web schemes', () => {
    expect(normalizeCredentialOrigin('file:///etc/passwd')).toBeNull()
    expect(normalizeCredentialOrigin('about:blank')).toBeNull()
    expect(normalizeCredentialOrigin('not a url')).toBeNull()
  })
})

describe('hostnameFromOrigin', () => {
  it('extracts the lowercased hostname', () => {
    expect(hostnameFromOrigin('https://github.com')).toBe('github.com')
  })

  it('returns null for invalid origins', () => {
    expect(hostnameFromOrigin('garbage')).toBeNull()
  })
})
