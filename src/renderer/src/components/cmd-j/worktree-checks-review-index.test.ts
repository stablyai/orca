import { describe, expect, it } from 'vitest'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getGitHubPRCacheKey } from '../../../../shared/github/github-cache-key'
import { getRepoHostIdentity } from '../../../../shared/repo-host-identity'
import { buildWorktreeChecksReviewIndex } from './worktree-checks-review-index'

const repo: Repo = {
  id: 'repo-1',
  path: '/remote/orca',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: 0,
  executionHostId: 'ssh:staging'
}

const worktree: Worktree = {
  id: 'worktree-1',
  repoId: repo.id,
  path: '/remote/orca-worktrees/search',
  head: 'abc123',
  branch: 'refs/heads/feature/search',
  isBare: false,
  isMainWorktree: false,
  displayName: 'Search reviews',
  comment: '',
  linkedIssue: null,
  linkedPR: 42,
  linkedLinearIssue: null,
  hostId: 'ssh:staging',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    title: 'Search worktrees by their pull requests',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/42',
    checksStatus: 'success',
    updatedAt: '2026-07-12T00:00:00Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

describe('buildWorktreeChecksReviewIndex', () => {
  it('keeps same-id worktrees isolated across execution hosts', () => {
    const localRepo: Repo = {
      ...repo,
      path: '/local/orca',
      executionHostId: 'local'
    }
    const localWorktree: Worktree = { ...worktree, hostId: 'local' }
    const sshWorktree: Worktree = { ...worktree, hostId: 'ssh:staging' }
    const sshKey = getGitHubPRCacheKey(
      repo.path,
      repo.id,
      'feature/search',
      null,
      repo.connectionId,
      repo.executionHostId,
      true
    )

    const reviews = buildWorktreeChecksReviewIndex({
      worktrees: [localWorktree, sshWorktree],
      repoByHostIdentity: new Map([
        [getRepoHostIdentity(localRepo), localRepo],
        [getRepoHostIdentity(repo), repo]
      ]),
      prCache: { [sshKey]: { data: makePR(), fetchedAt: 1 } },
      hostedReviewCache: {},
      settings: null
    })

    expect(reviews.has(localWorktree)).toBe(false)
    expect(reviews.get(sshWorktree)).toMatchObject({ provider: 'github', number: 42 })
  })
})
