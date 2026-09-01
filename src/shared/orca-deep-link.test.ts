import { describe, expect, it } from 'vitest'
import { orcaDeepLinkFromArguments, parseOrcaDeepLink } from './orca-deep-link'

describe('parseOrcaDeepLink', () => {
  it('parses a terminal focus link', () => {
    expect(parseOrcaDeepLink('orca://focus/term_abc123')).toEqual({
      kind: 'focus',
      handle: 'term_abc123'
    })
  })

  it('preserves handle case (path, not host)', () => {
    expect(parseOrcaDeepLink('orca://focus/term_AbC-99F0')).toEqual({
      kind: 'focus',
      handle: 'term_AbC-99F0'
    })
  })

  it('decodes percent-encoded handles', () => {
    expect(parseOrcaDeepLink('orca://focus/term_%41bc')).toEqual({
      kind: 'focus',
      handle: 'term_Abc'
    })
  })

  it('ignores the web-only pair host', () => {
    expect(parseOrcaDeepLink('orca://pair?code=xyz')).toBeNull()
  })

  it('ignores a skill-share link', () => {
    expect(parseOrcaDeepLink('orca://skills/share/abc')).toBeNull()
  })

  it('rejects other schemes', () => {
    expect(parseOrcaDeepLink('https://focus/term_abc')).toBeNull()
    expect(parseOrcaDeepLink('file:///focus/term_abc')).toBeNull()
  })

  it('rejects an empty or malformed handle', () => {
    expect(parseOrcaDeepLink('orca://focus/')).toBeNull()
    expect(parseOrcaDeepLink('orca://focus')).toBeNull()
    expect(parseOrcaDeepLink('orca://focus/has spaces')).toBeNull()
    expect(parseOrcaDeepLink('orca://focus/term/extra')).toBeNull()
  })

  it('rejects non-URL input', () => {
    expect(parseOrcaDeepLink('not a url')).toBeNull()
  })
})

describe('orcaDeepLinkFromArguments', () => {
  it('finds the orca:// argument among other args', () => {
    expect(orcaDeepLinkFromArguments(['/path/to/orca', '--flag', 'orca://focus/term_1'])).toBe(
      'orca://focus/term_1'
    )
  })

  it('returns null when no orca argument is present', () => {
    expect(orcaDeepLinkFromArguments(['/path/to/orca', '--serve'])).toBeNull()
  })

  it('returns null for undefined argv', () => {
    expect(orcaDeepLinkFromArguments(undefined)).toBeNull()
  })

  // Unlike a bare startsWith check, this arg is skipped because it fails parseOrcaDeepLink.
  it('returns null for an orca:// argument that is not a valid focus link', () => {
    expect(orcaDeepLinkFromArguments(['/path/to/orca', 'orca://garbage'])).toBeNull()
  })
})
