import { describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import {
  getParentPrChecksRefreshCandidates,
  runLimitedParentPrChecksRefreshes
} from './parent-pr-checks-refresh'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#fff',
    addedAt: 1,
    kind: 'git',
    connectionId: 'ssh-1',
    executionHostId: 'ssh:ssh-1',
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    path: `/worktrees/${overrides.id}`,
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    repoId: 'repo-1',
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 7,
    title: 'Review',
    state: 'open',
    url: 'https://example.test/review/7',
    status: 'success',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha: 'abc123',
    ...overrides
  }
}

describe('parent PR checks refresh', () => {
  it('caps concurrency while refreshing candidates', async () => {
    const repo = makeRepo()
    const worktrees = Array.from({ length: 5 }, (_, index) =>
      makeWorktree({
        id: `repo-1::/${index}`,
        displayName: `Worktree ${index}`
      })
    )
    const candidates = getParentPrChecksRefreshCandidates({
      worktrees,
      repos: [repo]
    })
    let active = 0
    let maxActive = 0
    const fetchHostedReviewForBranch = vi.fn(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return makeReview()
    })

    await runLimitedParentPrChecksRefreshes({
      candidates,
      concurrency: 2,
      fetchHostedReviewForBranch
    })

    expect(maxActive).toBeLessThanOrEqual(2)
    expect(fetchHostedReviewForBranch).toHaveBeenCalledTimes(5)
  })

  it('uses non-forced refreshes by default', async () => {
    const repo = makeRepo()
    const worktree = makeWorktree({ id: 'repo-1::/default-force' })
    const fetchHostedReviewForBranch = vi.fn(
      async (_repoPath: string, _branch: string, _options: Record<string, unknown>) => makeReview()
    )

    await runLimitedParentPrChecksRefreshes({
      candidates: getParentPrChecksRefreshCandidates({ worktrees: [worktree], repos: [repo] }),
      fetchHostedReviewForBranch
    })

    expect(fetchHostedReviewForBranch.mock.calls[0]?.[2]).toMatchObject({ force: false })
  })

  it('prioritizes linked reviews and passes SSH-safe repo/provider context', async () => {
    const repo = makeRepo()
    const unlinked = makeWorktree({
      id: 'repo-1::/unlinked',
      displayName: 'A unlinked'
    })
    const linked = makeWorktree({
      id: 'repo-1::/linked',
      displayName: 'Z linked',
      linkedPR: 7,
      linkedGitLabMR: 9,
      linkedBitbucketPR: 10,
      linkedAzureDevOpsPR: 11,
      linkedGiteaPR: 12
    })
    const candidates = getParentPrChecksRefreshCandidates({
      worktrees: [unlinked, linked],
      repos: [repo]
    })
    const fetchHostedReviewForBranch = vi.fn(async () => makeReview())
    const fetchPRChecks = vi.fn(async () => [])

    await runLimitedParentPrChecksRefreshes({
      candidates,
      concurrency: 1,
      fetchHostedReviewForBranch,
      fetchPRChecks
    })

    expect(fetchHostedReviewForBranch.mock.calls[0]).toEqual([
      '/repo',
      'feature',
      {
        force: false,
        repoId: 'repo-1',
        linkedGitHubPR: 7,
        linkedGitLabMR: 9,
        linkedBitbucketPR: 10,
        linkedAzureDevOpsPR: 11,
        linkedGiteaPR: 12,
        staleWhileRevalidate: true
      }
    ])
    expect(fetchPRChecks).toHaveBeenCalledWith('/repo', 7, 'feature', 'abc123', null, {
      repoId: 'repo-1',
      force: false
    })
  })

  it('keeps ambiguous null neutral while preserving thrown refresh failures as errors', async () => {
    const repo = makeRepo()
    const unlinked = makeWorktree({ id: 'repo-1::/unlinked' })
    const linked = makeWorktree({ id: 'repo-1::/linked', linkedGitLabMR: 5 })
    const ambiguousNull = await runLimitedParentPrChecksRefreshes({
      candidates: getParentPrChecksRefreshCandidates({
        worktrees: [unlinked],
        repos: [repo]
      }),
      fetchHostedReviewForBranch: vi.fn(async () => null)
    })
    const failed = await runLimitedParentPrChecksRefreshes({
      candidates: getParentPrChecksRefreshCandidates({
        worktrees: [linked],
        repos: [repo]
      }),
      fetchHostedReviewForBranch: vi.fn(async () => {
        throw new Error('nope')
      })
    })

    expect([...ambiguousNull.values()][0]?.kind).toBe('unavailable')
    expect([...failed.values()][0]?.kind).toBe('error')
  })
})
