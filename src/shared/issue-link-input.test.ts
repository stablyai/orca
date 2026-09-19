import { describe, expect, it } from 'vitest'

import {
  getIssueLinkProviderFromUrl,
  ISSUE_LINK_PROVIDERS,
  isIssueLinkProvider,
  parseIssueLinkInput
} from './issue-link-input'

describe('getIssueLinkProviderFromUrl', () => {
  it('detects GitHub issue URLs', () => {
    expect(getIssueLinkProviderFromUrl('https://github.com/o/r/issues/12')).toBe('github')
  })

  it('does not flip the provider for a GitHub pull URL', () => {
    expect(getIssueLinkProviderFromUrl('https://github.com/o/r/pull/12')).toBeNull()
  })

  it('detects Linear issue URLs with and without a slug', () => {
    expect(getIssueLinkProviderFromUrl('https://linear.app/acme/issue/STA-335')).toBe('linear')
    expect(getIssueLinkProviderFromUrl('https://linear.app/acme/issue/STA-335/some-slug')).toBe(
      'linear'
    )
  })

  it('ignores non-issue paths on the Linear host', () => {
    expect(getIssueLinkProviderFromUrl('https://linear.app/acme/team/ENG/all')).toBeNull()
  })

  it('rejects hosts that merely contain linear.app', () => {
    expect(getIssueLinkProviderFromUrl('https://linear.app.evil.com/acme/issue/STA-335')).toBeNull()
  })

  // Linear and Jira issue-key shapes are byte-identical, so a bare key must
  // never override the user's explicit provider choice.
  it('is not decisive for bare issue keys', () => {
    expect(getIssueLinkProviderFromUrl('STA-335')).toBeNull()
    expect(getIssueLinkProviderFromUrl('  STA-335  ')).toBeNull()
  })

  it('is not decisive for bare numbers', () => {
    expect(getIssueLinkProviderFromUrl('1234')).toBeNull()
    expect(getIssueLinkProviderFromUrl('#1234')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(getIssueLinkProviderFromUrl('')).toBeNull()
    expect(getIssueLinkProviderFromUrl('   ')).toBeNull()
  })

  it('detects GitLab issue and work-item URLs on any host', () => {
    expect(getIssueLinkProviderFromUrl('https://gitlab.com/acme/app/-/issues/12')).toBe('gitlab')
    expect(
      getIssueLinkProviderFromUrl('https://gitlab.example.com/group/sub/app/-/work_items/12')
    ).toBe('gitlab')
  })

  it('does not flip the provider for a GitLab merge request URL', () => {
    expect(
      getIssueLinkProviderFromUrl('https://gitlab.com/acme/app/-/merge_requests/12')
    ).toBeNull()
  })
})

describe('parseIssueLinkInput', () => {
  describe('github provider', () => {
    it('accepts bare and hash-prefixed numbers', () => {
      expect(parseIssueLinkInput('12', 'github')).toEqual({ provider: 'github', number: 12 })
      expect(parseIssueLinkInput('#12', 'github')).toEqual({ provider: 'github', number: 12 })
    })

    it('accepts issue URLs', () => {
      expect(parseIssueLinkInput('https://github.com/o/r/issues/12', 'github')).toEqual({
        provider: 'github',
        number: 12
      })
    })

    it('rejects pull URLs', () => {
      expect(parseIssueLinkInput('https://github.com/o/r/pull/12', 'github')).toBeNull()
    })

    it('rejects non-positive numbers and junk', () => {
      expect(parseIssueLinkInput('0', 'github')).toBeNull()
      expect(parseIssueLinkInput('-1', 'github')).toBeNull()
      expect(parseIssueLinkInput('not an issue', 'github')).toBeNull()
      expect(parseIssueLinkInput('   ', 'github')).toBeNull()
    })

    it('rejects Linear identifiers', () => {
      expect(parseIssueLinkInput('STA-335', 'github')).toBeNull()
    })

    // Past the safe-integer range every digit string parses to the same float,
    // so an unbounded parse would link an arbitrary issue number.
    it('rejects numbers beyond the safe-integer range', () => {
      expect(parseIssueLinkInput('9'.repeat(400), 'github')).toBeNull()
    })
  })

  describe('linear provider', () => {
    it('accepts bare identifiers and normalizes case', () => {
      expect(parseIssueLinkInput('STA-335', 'linear')).toEqual({
        provider: 'linear',
        identifier: 'STA-335'
      })
      expect(parseIssueLinkInput('sta-335', 'linear')).toEqual({
        provider: 'linear',
        identifier: 'STA-335'
      })
    })

    it('omits the organization key for bare identifiers', () => {
      expect(parseIssueLinkInput('STA-335', 'linear')).not.toHaveProperty('organizationUrlKey')
    })

    it('accepts issue URLs and returns the organization key', () => {
      expect(
        parseIssueLinkInput('https://linear.app/acme/issue/STA-335/some-slug', 'linear')
      ).toEqual({
        provider: 'linear',
        identifier: 'STA-335',
        organizationUrlKey: 'acme'
      })
    })

    it('rejects GitHub URLs', () => {
      expect(parseIssueLinkInput('https://github.com/o/r/issues/12', 'linear')).toBeNull()
    })

    it('rejects junk and empty input', () => {
      expect(parseIssueLinkInput('not an issue', 'linear')).toBeNull()
      expect(parseIssueLinkInput('   ', 'linear')).toBeNull()
    })
  })

  describe('gitlab provider', () => {
    it('accepts bare and hash-prefixed numbers', () => {
      expect(parseIssueLinkInput('12', 'gitlab')).toEqual({ provider: 'gitlab', number: 12 })
      expect(parseIssueLinkInput('#12', 'gitlab')).toEqual({ provider: 'gitlab', number: 12 })
    })

    it('accepts issue and work-item URLs', () => {
      expect(parseIssueLinkInput('https://gitlab.com/acme/app/-/issues/12', 'gitlab')).toEqual({
        provider: 'gitlab',
        number: 12
      })
      expect(
        parseIssueLinkInput('https://gitlab.example.com/g/s/app/-/work_items/3', 'gitlab')
      ).toEqual({ provider: 'gitlab', number: 3 })
    })

    // `!` is GitLab's MR sigil; an MR must never land in the issue slot.
    it('rejects merge request URLs and !-prefixed numbers', () => {
      expect(
        parseIssueLinkInput('https://gitlab.com/acme/app/-/merge_requests/12', 'gitlab')
      ).toBeNull()
      expect(parseIssueLinkInput('!12', 'gitlab')).toBeNull()
    })

    it('rejects GitHub URLs, junk, and unsafe numbers', () => {
      expect(parseIssueLinkInput('https://github.com/o/r/issues/12', 'gitlab')).toBeNull()
      expect(parseIssueLinkInput('0', 'gitlab')).toBeNull()
      expect(parseIssueLinkInput('STA-335', 'gitlab')).toBeNull()
      expect(parseIssueLinkInput('9'.repeat(400), 'gitlab')).toBeNull()
    })
  })

  it('offers gitlab in the dropdown order, next to github', () => {
    expect(ISSUE_LINK_PROVIDERS).toEqual(['github', 'gitlab', 'linear'])
    expect(isIssueLinkProvider('gitlab')).toBe(true)
  })
})
