import { describe, expect, it } from 'vitest'
import { matchesShippedBranch } from './shipped-branch-pr-match'

describe('matchesShippedBranch', () => {
  it('matches a pushed head that prefixes + dashes the local branch', () => {
    expect(matchesShippedBranch('zaridan/chore-gtm-e2e-ci', 'chore/gtm-e2e-ci')).toBe(true)
  })

  it('matches multi-segment branches without truncation', () => {
    expect(
      matchesShippedBranch('zaridan/fix-gtm-graduate-stub-routes', 'fix/gtm-graduate-stub-routes')
    ).toBe(true)
  })

  it('matches when the branch was not renamed (raw head)', () => {
    expect(matchesShippedBranch('chore/gtm-e2e-ci', 'chore/gtm-e2e-ci')).toBe(true)
  })

  it('does not match a different branch that merely shares a short suffix', () => {
    // local `e2e-ci` must not match `zaridan/chore-gtm-e2e-ci` — the dashed local
    // branch is not the full trailing path segment.
    expect(matchesShippedBranch('zaridan/chore-gtm-e2e-ci', 'e2e-ci')).toBe(false)
  })

  it('returns false for empty inputs', () => {
    expect(matchesShippedBranch('', 'chore/gtm-e2e-ci')).toBe(false)
    expect(matchesShippedBranch('zaridan/chore-gtm-e2e-ci', '')).toBe(false)
  })
})
