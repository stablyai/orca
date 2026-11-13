import { describe, expect, it } from 'vitest'
import { isSafeGitRefName, isSafeGitStatusUpstreamRef } from './git-status-upstream-ref'

describe('git status upstream refs', () => {
  it('recognizes local branch refs without accepting them for dynamic status polling', () => {
    expect(isSafeGitRefName('refs/heads/feature/base')).toBe(true)
    expect(isSafeGitStatusUpstreamRef('refs/heads/feature/base')).toBe(false)
    expect(isSafeGitStatusUpstreamRef('refs/worktree/feature/base')).toBe(false)
  })

  it.each([
    'refs/heads/main',
    '/refs/remotes/origin/main',
    'refs/remotes/origin/../main',
    'refs/remotes/origin/main.lock',
    'refs/remotes/origin/feature\\escape',
    'refs/remotes/origin/@{upstream}'
  ])('rejects unsafe or non-remote ref %s', (ref) => {
    expect(isSafeGitStatusUpstreamRef(ref)).toBe(false)
  })
})
