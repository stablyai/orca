import { describe, expect, it } from 'vitest'
import { assertValidGitPushTarget } from './git-push-target-validation'

describe('assertValidGitPushTarget', () => {
  it('accepts slash-separated git remote names', () => {
    expect(() =>
      assertValidGitPushTarget({ remoteName: 'foo/bar', branchName: 'feature/fix' })
    ).not.toThrow()
  })

  it('rejects remote names with empty or parent segments', () => {
    expect(() =>
      assertValidGitPushTarget({ remoteName: 'foo//bar', branchName: 'feature/fix' })
    ).toThrow('Invalid git remote name')
    expect(() =>
      assertValidGitPushTarget({ remoteName: 'foo/../bar', branchName: 'feature/fix' })
    ).toThrow('Invalid git remote name')
  })
})
