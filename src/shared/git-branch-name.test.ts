import { describe, expect, it } from 'vitest'
import { isValidGitBranchName } from './git-branch-name'

describe('isValidGitBranchName', () => {
  it.each([
    'mission/referral',
    'feature/한글-수정',
    'feature/🚀',
    'topic',
    '@',
    'refs/heads/nested',
    'topic/-inner-dash'
  ])('accepts the Git branch name %s', (branchName) => {
    expect(isValidGitBranchName(branchName)).toBe(true)
  })

  it.each([
    '',
    'HEAD',
    '-leading-option',
    '/leading',
    'trailing/',
    'double//slash',
    'double..dot',
    '.hidden/topic',
    'topic/.hidden',
    'topic.lock',
    'topic/trailing.',
    'topic@{1}',
    '@{-1}',
    'topic with space',
    'topic~parent',
    'topic^peel',
    'topic:destination',
    'topic?glob',
    'topic*glob',
    'topic[glob',
    'topic\\windows',
    'topic\ud800unpaired-high',
    'topic\udcffunpaired-low',
    'topic\u0000nul',
    'topic\u001fcontrol',
    'topic\u007fdelete'
  ])('rejects the unsupported branch name %s', (branchName) => {
    expect(isValidGitBranchName(branchName)).toBe(false)
  })
})
