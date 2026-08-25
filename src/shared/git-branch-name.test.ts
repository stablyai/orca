import { describe, expect, it } from 'vitest'
import {
  assertValidGitBranchName,
  checkGitBranchName,
  isValidGitBranchName
} from './git-branch-name'

describe('checkGitBranchName', () => {
  it.each([
    'main',
    'feature/add-thing',
    'release-1.2.3',
    'user/JIRA-42_fix',
    'a',
    'deep/nested/branch/name'
  ])('accepts %s', (branch) => {
    expect(checkGitBranchName(branch)).toEqual({ ok: true })
  })

  it.each([
    ['', 'empty'],
    ['-rf', 'leading-dash'],
    ['--upload-pack=evil', 'leading-dash'],
    ['@', 'reserved'],
    ['has space', 'invalid-characters'],
    ['tilde~1', 'invalid-characters'],
    ['caret^2', 'invalid-characters'],
    ['colon:name', 'invalid-characters'],
    ['question?', 'invalid-characters'],
    ['star*', 'invalid-characters'],
    ['bracket[0]', 'invalid-characters'],
    ['back\\slash', 'invalid-characters'],
    ['double..dot', 'invalid-characters'],
    ['at@{brace', 'invalid-characters'],
    ['/leading', 'invalid-path-component'],
    ['trailing/', 'invalid-path-component'],
    ['double//slash', 'invalid-path-component'],
    ['trailing.', 'invalid-path-component'],
    ['.hidden', 'invalid-path-component'],
    ['nested/.hidden', 'invalid-path-component'],
    ['name.lock', 'invalid-path-component'],
    ['nested/name.lock', 'invalid-path-component']
  ])('rejects %s as %s', (branch, reason) => {
    expect(checkGitBranchName(branch)).toEqual({ ok: false, reason })
  })

  it('rejects control characters that would otherwise reach the git argv', () => {
    const newline = String.fromCharCode(10)
    const del = String.fromCharCode(127)
    const nul = String.fromCharCode(0)

    expect(isValidGitBranchName(`bad${newline}name`)).toBe(false)
    expect(isValidGitBranchName(`bad${del}name`)).toBe(false)
    expect(isValidGitBranchName(`bad${nul}name`)).toBe(false)
  })
})

describe('assertValidGitBranchName', () => {
  it('throws a stable error code for a name git would reject', () => {
    expect(() => assertValidGitBranchName('-rf')).toThrow('invalid_branch_name')
  })

  it('passes a valid name through', () => {
    expect(() => assertValidGitBranchName('feature/ok')).not.toThrow()
  })
})
