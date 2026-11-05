import { describe, expect, it } from 'vitest'

import {
  GITHUB_OWNER_NUMBER_SHORTHAND_RE,
  GITHUB_OWNER_SLUG_RE,
  isGitHubOwnerSlug
} from './owner-slug'

describe('GitHub owner slug alphabet', () => {
  it('accepts plain logins and Enterprise Managed User logins', () => {
    for (const owner of ['acme', 'acme-co', 'user1', 'octocat_acme', 'acme_co']) {
      expect(GITHUB_OWNER_SLUG_RE.test(owner)).toBe(true)
      expect(isGitHubOwnerSlug(owner)).toBe(true)
    }
  })

  it('rejects a leading underscore, hyphen or dot, and path-shaped values', () => {
    for (const owner of [
      '_acme',
      '-acme',
      '.acme',
      'a/b',
      'a.b',
      'a_b/c',
      'a_b\\c',
      'a_b%2Fc',
      'a_b?c',
      'a_b#c',
      ''
    ]) {
      expect(GITHUB_OWNER_SLUG_RE.test(owner)).toBe(false)
      expect(isGitHubOwnerSlug(owner)).toBe(false)
    }
    expect(isGitHubOwnerSlug(123)).toBe(false)
  })

  it('shorthand captures the same owner alphabet plus a number', () => {
    expect(GITHUB_OWNER_NUMBER_SHORTHAND_RE.exec('octocat_acme/12')?.slice(1)).toEqual([
      'octocat_acme',
      '12'
    ])
    expect(GITHUB_OWNER_NUMBER_SHORTHAND_RE.test('_acme/12')).toBe(false)
    expect(GITHUB_OWNER_NUMBER_SHORTHAND_RE.test('acme/x')).toBe(false)
  })
})
