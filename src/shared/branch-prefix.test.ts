import { describe, expect, it } from 'vitest'
import {
  assertBranchPrefixValid,
  getBranchPrefixIssue,
  getBranchPrefixSeparator,
  getBranchPrefixSeparatorIssue,
  normalizeBranchPrefix,
  selectBranchPrefixInput
} from './branch-prefix'

describe('getBranchPrefixSeparator', () => {
  it('returns default slash when undefined or null', () => {
    expect(getBranchPrefixSeparator(undefined)).toBe('/')
    expect(getBranchPrefixSeparator(null)).toBe('/')
    expect(getBranchPrefixSeparator({})).toBe('/')
  })

  it('returns default slash when empty string', () => {
    expect(getBranchPrefixSeparator({ branchPrefixSeparator: '' })).toBe('/')
  })

  it('returns custom separator when configured', () => {
    expect(getBranchPrefixSeparator({ branchPrefixSeparator: '-' })).toBe('-')
    expect(getBranchPrefixSeparator({ branchPrefixSeparator: '_' })).toBe('_')
  })
})

describe('getBranchPrefixSeparatorIssue', () => {
  it('accepts common separators', () => {
    expect(getBranchPrefixSeparatorIssue('/')).toBeNull()
    expect(getBranchPrefixSeparatorIssue('-')).toBeNull()
    expect(getBranchPrefixSeparatorIssue('_')).toBeNull()
    expect(getBranchPrefixSeparatorIssue('.')).toBeNull()
  })

  it('treats empty as valid (will fallback)', () => {
    expect(getBranchPrefixSeparatorIssue('')).toBeNull()
  })

  it('flags spaces and control characters', () => {
    expect(getBranchPrefixSeparatorIssue(' ')).toBe('invalid-characters')
    expect(getBranchPrefixSeparatorIssue('-\t')).toBe('invalid-characters')
  })

  it('flags git ref-reserved characters', () => {
    expect(getBranchPrefixSeparatorIssue('~')).toBe('invalid-characters')
    expect(getBranchPrefixSeparatorIssue(':')).toBe('invalid-characters')
    expect(getBranchPrefixSeparatorIssue('?')).toBe('invalid-characters')
    expect(getBranchPrefixSeparatorIssue('..')).toBe('invalid-characters')
    expect(getBranchPrefixSeparatorIssue('//')).toBe('invalid-characters')
    expect(getBranchPrefixSeparatorIssue('@{')).toBe('invalid-characters')
  })
})

describe('normalizeBranchPrefix', () => {
  it('strips a trailing slash so the join does not double it', () => {
    expect(normalizeBranchPrefix('team/')).toBe('team')
  })

  it('strips trailing custom separator so join does not double it', () => {
    expect(normalizeBranchPrefix('team-', '-')).toBe('team')
    expect(normalizeBranchPrefix('team--', '-')).toBe('team')
    expect(normalizeBranchPrefix('-team-', '-')).toBe('team')
  })

  it('preserves inner hyphens when separator is hyphen', () => {
    expect(normalizeBranchPrefix('team-frontend', '-')).toBe('team-frontend')
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

  it('does not throw for a valid prefix with valid separator', () => {
    expect(() => assertBranchPrefixValid('team', '-')).not.toThrow()
  })

  it('throws with a settings hint for an invalid prefix', () => {
    expect(() => assertBranchPrefixValid('team x')).toThrow(
      'Branch prefix "team x" contains characters git rejects — update it in Settings → Git'
    )
  })

  it('throws with a settings hint for an invalid separator', () => {
    expect(() => assertBranchPrefixValid('team', ':')).toThrow(
      'Branch prefix separator ":" contains characters git rejects — update it in Settings → Git'
    )
  })
})

it('keeps an unknown prefix strategy as the original implicit undefined result', () => {
  expect(selectBranchPrefixInput({ branchPrefix: 'future-prefix' }, 'user')).toBeUndefined()
})
