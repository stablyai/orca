import { expect, it, vi } from 'vitest'
import {
  assertGitReviewPushAuthority,
  readGitReviewPushAuthority
} from './git-review-push-authority'
import type { GitPushTarget } from './worktree/types'

const target: GitPushTarget = {
  remoteName: 'origin',
  branchName: 'feature',
  reviewHead: {
    provider: 'github',
    host: 'github.com',
    repository: 'team/repo',
    branchName: 'feature'
  }
}

it.each([
  [['https://github.com/team/repo.git'], 'verified'],
  [['git@github.com:team/repo.git'], 'verified'],
  [['ssh://git@ssh.github.com:443/team/repo.git'], 'verified'],
  [['https://github.com/other/repo.git'], 'mismatch'],
  [['https://github.com/team/other.git'], 'mismatch'],
  [['https://github.other.com/team/repo.git'], 'mismatch'],
  [['https://github.com/team/repo.git', 'https://github.com/other/repo.git'], 'ambiguous'],
  [['https://github.com/team/repo.git', 'git@github.com:team/repo.git'], 'ambiguous'],
  [[], 'unverifiable']
])('binds the entire push destination set %j', async (urls, expected) => {
  const run = vi.fn(async () => ({
    stdout: [
      'origin\thttps://github.com/team/repo.git (fetch)',
      ...urls.map((url) => `origin\t${url} (push)`)
    ].join('\n')
  }))
  expect((await readGitReviewPushAuthority(run, target)).kind).toBe(expected)
  expect(run).toHaveBeenCalledWith(['remote', '-v'])
  if (expected !== 'verified') {
    await expect(assertGitReviewPushAuthority(run, target)).rejects.toThrow(String(expected))
  }
})

it('does not promote legacy metadata, matching fetch identity, or remoteCreated', async () => {
  const run = vi.fn()
  expect(
    await readGitReviewPushAuthority(run, {
      remoteName: 'origin',
      branchName: 'feature',
      remoteCreated: true
    })
  ).toEqual({ kind: 'unresolved' })
  expect(run).not.toHaveBeenCalled()
})

it('corroborates GitLab nested project identity and host aliases', async () => {
  const gitlab: GitPushTarget = {
    ...target,
    reviewHead: {
      provider: 'gitlab',
      host: 'gitlab.com',
      repository: 'team/group/repo',
      branchName: 'feature'
    }
  }
  expect(
    (
      await readGitReviewPushAuthority(
        async () => ({
          stdout: 'origin\tssh://git@altssh.gitlab.com:443/team/group/repo.git (push)'
        }),
        gitlab
      )
    ).kind
  ).toBe('verified')
})

it('reports failed host reads as unverifiable and never substitutes execution', async () => {
  const run = vi.fn().mockRejectedValue(new Error('disconnected'))
  expect((await readGitReviewPushAuthority(run, target)).kind).toBe('unverifiable')
  expect(run).toHaveBeenCalledOnce()
})
