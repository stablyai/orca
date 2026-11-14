import { describe, expect, it } from 'vitest'
import type { PRCheckDetail } from '../../../../../../shared/github/checks/check-types'
import type { PRInfo } from '../../../../../../shared/github/pull-requests/pull-request-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review/hosted-review-cache-identity'
import {
  getGitHubPRCacheKey,
  getGitHubRepoCacheKey
} from '../../../../../../shared/github/cache/github-cache-key'
import { prChecksCacheSuffix } from '@/store/github/cache/cache-identity'
import {
  buildParentPrChecksProjection,
  getParentPrChecksRefreshIdentity
} from './parent-pr-checks-rows'
import type { ParentPrChecksRefreshOutcome } from './parent-pr-checks-row-types'

const settings = null as never

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#fff',
    addedAt: 1,
    kind: 'git',
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
    number: 12,
    title: 'Review title',
    state: 'open',
    url: 'https://example.test/review/12',
    status: 'success',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

function makePRInfo(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    title: 'Branch PR',
    state: 'open',
    url: 'https://example.test/pull/42',
    checksStatus: 'success',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

function makeProjection({
  worktree = makeWorktree({ id: 'repo-1::/feature' }),
  repo = makeRepo(),
  hostedReviewCache = {},
  prCache = {},
  checksCache = {},
  refreshOutcomes
}: {
  worktree?: Worktree
  repo?: Repo
  hostedReviewCache?: Record<
    string,
    { data: HostedReviewInfo | null; fetchedAt: number; linkedReviewHintKey?: string }
  >
  prCache?: Record<string, { data: PRInfo | null; fetchedAt: number }>
  checksCache?: Record<
    string,
    { data: PRCheckDetail[] | null; fetchedAt: number; headSha?: string }
  >
  refreshOutcomes?: ReadonlyMap<string, ParentPrChecksRefreshOutcome>
} = {}) {
  return buildParentPrChecksProjection({
    worktrees: [worktree],
    repos: [repo],
    settings,
    hostedReviewCache,
    prCache,
    checksCache,
    refreshOutcomes
  })
}

describe('buildParentPrChecksProjection', () => {
  it('drops a completed merged lookup when its worktree has moved to another head', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({ id: 'repo-1::/feature', head: 'merged-head' })
    const identity = getParentPrChecksRefreshIdentity(worktree, repo, 'feature')
    const review = makeReview({ state: 'merged', headSha: 'merged-head' })
    const refreshOutcomes = new Map<string, ParentPrChecksRefreshOutcome>([
      [identity, { kind: 'found', review }]
    ])

    expect(makeProjection({ worktree, repo, refreshOutcomes }).rows[0].reviewNumber).toBe(12)
    expect(
      makeProjection({
        worktree: { ...worktree, head: 'new-work-head' },
        repo,
        refreshOutcomes
      }).rows[0].reviewNumber
    ).toBeNull()
  })

  it('falls through a suppressed live outcome to a different cached PR', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({
      id: 'repo-1::/feature',
      linkedPR: null,
      suppressedGitHubPR: 99
    })
    const identity = getParentPrChecksRefreshIdentity(worktree, repo, 'feature')
    const cacheKey = getGitHubPRCacheKey(repo.path, repo.id, 'feature', settings)

    expect(
      makeProjection({
        worktree,
        repo,
        prCache: {
          [cacheKey]: { data: makePRInfo({ number: 100 }), fetchedAt: 2 }
        },
        refreshOutcomes: new Map([
          [identity, { kind: 'found', review: makeReview({ number: 99 }) }]
        ])
      }).rows[0]
    ).toMatchObject({ reviewNumber: 100, reviewLabel: '#100' })
  })

  it('prioritizes action-required check detail names before truncating the preview', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({ id: 'repo-1::/feature' })
    const review = makeReview({ status: 'failure', headSha: 'abc123' })
    const hostedKey = getHostedReviewCacheKey(repo.path, 'feature', settings, repo.id)
    const checksKey = getGitHubRepoCacheKey(
      repo.path,
      repo.id,
      prChecksCacheSuffix(12, null, 'abc123'),
      settings
    )

    const projection = makeProjection({
      worktree,
      repo,
      hostedReviewCache: { [hostedKey]: { data: review, fetchedAt: 1, linkedReviewHintKey: '' } },
      checksCache: {
        [checksKey]: {
          data: [
            { name: 'build', status: 'completed', conclusion: 'failure', url: null },
            { name: 'lint', status: 'in_progress', conclusion: null, url: null },
            {
              name: 'GitHub Actions #1001',
              status: 'completed',
              conclusion: 'action_required',
              url: null
            }
          ],
          fetchedAt: 1,
          headSha: 'abc123'
        }
      }
    })

    expect(projection.rows[0]?.detailNames).toEqual(['GitHub Actions #1001', 'build'])
  })
})
