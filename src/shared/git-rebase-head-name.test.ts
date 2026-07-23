import { describe, expect, it } from 'vitest'
import { parseRebaseHeadName } from './git-rebase-head-name'

describe('parseRebaseHeadName', () => {
  it('extracts the branch from a clean refs/heads ref', () => {
    expect(parseRebaseHeadName('refs/heads/feature/x\n')).toBe('feature/x')
  })

  it('trims surrounding whitespace before matching', () => {
    expect(parseRebaseHeadName('  refs/heads/main  ')).toBe('main')
  })

  it('returns null for the literal "detached HEAD" head-name', () => {
    expect(parseRebaseHeadName('detached HEAD\n')).toBeNull()
  })

  it('returns null for a non-branch ref', () => {
    expect(parseRebaseHeadName('refs/tags/v1\n')).toBeNull()
  })

  it('rejects a corrupt value with interior whitespace so it cannot poison PR lookups', () => {
    expect(parseRebaseHeadName('refs/heads/feature\nx')).toBeNull()
    expect(parseRebaseHeadName('refs/heads/feature x')).toBeNull()
  })

  it('returns null for empty content', () => {
    expect(parseRebaseHeadName('')).toBeNull()
  })

  it('returns null (not an empty branch) for a bare refs/heads/ prefix', () => {
    expect(parseRebaseHeadName('refs/heads/\n')).toBeNull()
    expect(parseRebaseHeadName('  refs/heads/  ')).toBeNull()
  })
})
