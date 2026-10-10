import { describe, expect, it } from 'vitest'
import {
  assertBranchPrefixValid,
  getBranchPrefixIssue,
  gitUsernamePrefixOmission,
  normalizeBranchPrefix,
  selectBranchPrefixInput
} from './branch-prefix'

describe('normalizeBranchPrefix', () => {
  it('strips a trailing slash so the join does not double it', () => {
    expect(normalizeBranchPrefix('team/')).toBe('team')
  })

  it('strips a leading slash', () => {
    expect(normalizeBranchPrefix('/team')).toBe('team')
  })

  it('collapses internal double slashes', () => {
    expect(normalizeBranchPrefix('team//frontend')).toBe('team/frontend')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeBranchPrefix('  team  ')).toBe('team')
  })

  it('preserves a legitimate multi-segment prefix', () => {
    expect(normalizeBranchPrefix('team/frontend')).toBe('team/frontend')
  })

  it('returns empty when the value is only slashes/whitespace', () => {
    expect(normalizeBranchPrefix(' // ')).toBe('')
  })

  it('leaves a plain prefix untouched', () => {
    expect(normalizeBranchPrefix('feature')).toBe('feature')
  })
})

describe('getBranchPrefixIssue', () => {
  it('accepts a normal prefix', () => {
    expect(getBranchPrefixIssue('team')).toBeNull()
  })

  it('accepts a prefix that only needs trailing-slash normalization', () => {
    expect(getBranchPrefixIssue('team/')).toBeNull()
  })

  it('accepts a hyphenated prefix', () => {
    expect(getBranchPrefixIssue('feat-x')).toBeNull()
  })

  it('accepts a multi-segment prefix', () => {
    expect(getBranchPrefixIssue('team/frontend')).toBeNull()
  })

  it('accepts a mid-ref segment that ends with a dot (git allows it)', () => {
    expect(getBranchPrefixIssue('team./frontend')).toBeNull()
  })

  it('accepts a non-leading segment that starts with a dash (git allows it)', () => {
    expect(getBranchPrefixIssue('team/-frontend')).toBeNull()
  })

  it('treats an empty prefix as valid (no prefix)', () => {
    expect(getBranchPrefixIssue('')).toBeNull()
  })

  it('flags whitespace inside the prefix', () => {
    expect(getBranchPrefixIssue('team x')).toBe('invalid-characters')
  })

  it('flags git ref-reserved characters', () => {
    expect(getBranchPrefixIssue('team~')).toBe('invalid-characters')
    expect(getBranchPrefixIssue('team:x')).toBe('invalid-characters')
    expect(getBranchPrefixIssue('team[')).toBe('invalid-characters')
    expect(getBranchPrefixIssue('team\\')).toBe('invalid-characters')
  })

  it('flags ASCII control characters', () => {
    expect(getBranchPrefixIssue('team\x01')).toBe('invalid-characters')
  })

  it('flags a `..` sequence', () => {
    expect(getBranchPrefixIssue('team..x')).toBe('invalid-characters')
  })

  it('flags a `@{` sequence', () => {
    expect(getBranchPrefixIssue('team@{x')).toBe('invalid-characters')
  })

  it('flags a leading dash on the whole prefix', () => {
    expect(getBranchPrefixIssue('-team')).toBe('invalid-characters')
  })

  it('flags a segment starting with a dot', () => {
    expect(getBranchPrefixIssue('.team')).toBe('invalid-characters')
    expect(getBranchPrefixIssue('team/.frontend')).toBe('invalid-characters')
  })

  it('flags the whole prefix ending with a dot', () => {
    expect(getBranchPrefixIssue('team.')).toBe('invalid-characters')
    expect(getBranchPrefixIssue('team/frontend.')).toBe('invalid-characters')
  })

  it('flags a `.lock` suffix on any segment', () => {
    expect(getBranchPrefixIssue('team.lock')).toBe('invalid-characters')
    expect(getBranchPrefixIssue('team.lock/x')).toBe('invalid-characters')
  })
})

describe('selectBranchPrefixInput', () => {
  it('returns the git username for the git-username strategy', () => {
    expect(selectBranchPrefixInput({ branchPrefix: 'git-username' }, 'jdoe')).toBe('jdoe')
  })

  it('lowercases a git-username prefix so it cannot collide with an existing ref directory', () => {
    expect(selectBranchPrefixInput({ branchPrefix: 'git-username' }, 'EurFelux')).toBe('eurfelux')
  })

  it('drops a mixed-case login whose lowercase form git rejects', () => {
    expect(selectBranchPrefixInput({ branchPrefix: 'git-username' }, 'Alice.LOCK')).toBeNull()
    expect(gitUsernamePrefixOmission('Alice.LOCK')).toBe('lowercase-lock')
    expect(gitUsernamePrefixOmission('alice.lock')).toBeNull()
    expect(gitUsernamePrefixOmission('team x')).toBeNull()
    expect(gitUsernamePrefixOmission('EurFelux')).toBeNull()
    expect(gitUsernamePrefixOmission(null)).toBeNull()
  })

  it('returns an already-lowercase invalid login so settings can warn', () => {
    expect(selectBranchPrefixInput({ branchPrefix: 'git-username' }, 'alice.lock')).toBe('alice.lock')
    expect(selectBranchPrefixInput({ branchPrefix: 'git-username' }, 'team x')).toBe('team x')
  })

  it('leaves a custom prefix in the case the user typed', () => {
    expect(
      selectBranchPrefixInput(
        { branchPrefix: 'custom', branchPrefixCustom: 'EurFelux' },
        'eurfelux'
      )
    ).toBe('EurFelux')
  })

  it('returns null for git-username when no username is available', () => {
    expect(selectBranchPrefixInput({ branchPrefix: 'git-username' }, null)).toBeNull()
  })

  it('returns the raw custom value for the custom strategy', () => {
    expect(
      selectBranchPrefixInput({ branchPrefix: 'custom', branchPrefixCustom: 'team/' }, null)
    ).toBe('team/')
  })

  it('returns null for custom when no value is set', () => {
    expect(selectBranchPrefixInput({ branchPrefix: 'custom' }, null)).toBeNull()
  })

  it('returns null for the none strategy', () => {
    expect(selectBranchPrefixInput({ branchPrefix: 'none' }, 'jdoe')).toBeNull()
  })
})

describe('assertBranchPrefixValid', () => {
  it('does not throw for a valid prefix', () => {
    expect(() => assertBranchPrefixValid('team')).not.toThrow()
  })

  it('throws with a settings hint for an invalid prefix', () => {
    expect(() => assertBranchPrefixValid('team x')).toThrow(
      'Branch prefix "team x" contains characters git rejects — update it in Settings → Git'
    )
  })
})
