import { describe, expect, it } from 'vitest'
import { assertGitPushTargetShape } from './git-push-target-validation'

describe('assertGitPushTargetShape', () => {
  it('accepts slash-separated git remote names', () => {
    expect(() =>
      assertGitPushTargetShape({ remoteName: 'foo/bar', branchName: 'feature/fix' })
    ).not.toThrow()
  })

  it('rejects remote names with empty or parent segments', () => {
    expect(() =>
      assertGitPushTargetShape({ remoteName: 'foo//bar', branchName: 'feature/fix' })
    ).toThrow('Invalid git remote name')
    expect(() =>
      assertGitPushTargetShape({ remoteName: 'foo/../bar', branchName: 'feature/fix' })
    ).toThrow('Invalid git remote name')
  })
})
