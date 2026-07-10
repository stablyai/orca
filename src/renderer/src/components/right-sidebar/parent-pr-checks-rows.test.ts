import { describe, expect, it } from 'vitest'
import type { PRCheckDetail, PRInfo, Repo, Worktree } from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import {
  getGitHubPRCacheKey,
  getGitHubRepoCacheKey,
  getLegacyGitHubPRCacheKey
} from '@/store/slices/github-cache-key'
import { prChecksCacheSuffix } from '@/store/slices/github'
import {
  buildParentPrChecksProjection,
  getParentPrChecksRefreshIdentity,
  type ParentPrChecksRefreshOutcome
} from './parent-pr-checks-rows'

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
  it('classifies known review states into compact row groups', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({ id: 'repo-1::/feature' })
    const cacheKey = getHostedReviewCacheKey(repo.path, 'feature', settings, repo.id)

    expect(
      makeProjection({
        worktree,
        repo,
        hostedReviewCache: {
          [cacheKey]: {
            data: makeReview({ status: 'failure' }),
            fetchedAt: 1,
            linkedReviewHintKey: ''
          }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'failing',
      group: 'needsAttention',
      reviewLabel: '#12'
    })

    expect(
      makeProjection({
        worktree,
        repo,
        hostedReviewCache: {
          [cacheKey]: {
            data: makeReview({ status: 'pending' }),
            fetchedAt: 1,
            linkedReviewHintKey: ''
          }
        }
      }).rows[0]
    ).toMatchObject({ status: 'pending', group: 'pending' })

    expect(
      makeProjection({
        worktree,
        repo,
        hostedReviewCache: {
          [cacheKey]: {
            data: makeReview({ state: 'merged', headSha: 'abc' }),
            fetchedAt: 1,
            linkedReviewHintKey: ''
          }
        }
      }).rows[0]
    ).toMatchObject({ status: 'merged', group: 'merged' })

    expect(
      makeProjection({
        worktree,
        repo,
        hostedReviewCache: {
          [cacheKey]: {
            data: makeReview({ mergeable: 'CONFLICTING', status: 'success' }),
            fetchedAt: 1,
            linkedReviewHintKey: ''
          }
        }
      }).rows[0]
    ).toMatchObject({ status: 'conflict', group: 'needsAttention', checkTone: 'failure' })
  })

  it('only counts a visible successful unlinked no-review outcome as No PR', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({ id: 'repo-1::/feature' })
    const identity = getParentPrChecksRefreshIdentity(worktree, repo, 'feature')
    const coldNullKey = getHostedReviewCacheKey(repo.path, 'feature', settings, repo.id)

    const coldNull = makeProjection({
      worktree,
      repo,
      hostedReviewCache: { [coldNullKey]: { data: null, fetchedAt: 1 } }
    })
    expect(coldNull.rows[0]?.status).toBe('notFetched')
    expect(coldNull.summary.noPr).toBe(0)

    const provenNoReview = makeProjection({
      worktree,
      repo,
      refreshOutcomes: new Map([[identity, { kind: 'no-review' }]])
    })
    expect(provenNoReview.rows[0]?.status).toBe('noReview')
    expect(provenNoReview.summary.noPr).toBe(1)
  })

  it('uses branch-discovered PR cache for unlinked worktrees', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({ id: 'repo-1::/feature', linkedPR: null })
    const cacheKey = getGitHubPRCacheKey(repo.path, repo.id, 'feature', settings)

    expect(
      makeProjection({
        worktree,
        repo,
        prCache: {
          [cacheKey]: { data: makePRInfo({ number: 99 }), fetchedAt: 2 }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'success',
      group: 'passing',
      reviewNumber: 99,
      reviewLabel: '#99'
    })
  })

  it('uses legacy path-scoped PR cache for local persisted entries', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({ id: 'repo-1::/feature', linkedPR: 99 })
    const cacheKey = getLegacyGitHubPRCacheKey(repo.path, undefined, 'feature')

    expect(
      makeProjection({
        worktree,
        repo,
        prCache: {
          [cacheKey]: { data: makePRInfo({ number: 99, checksStatus: 'success' }), fetchedAt: 2 }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'success',
      reviewNumber: 99,
      reviewLabel: '#99'
    })
  })

  it('uses legacy path-scoped PR cache for explicit local repos', () => {
    const repo = makeRepo({ executionHostId: 'local' })
    const worktree = makeWorktree({ id: 'repo-1::/feature', linkedPR: 99 })
    const cacheKey = getLegacyGitHubPRCacheKey(repo.path, undefined, 'feature')

    expect(
      makeProjection({
        worktree,
        repo,
        prCache: {
          [cacheKey]: { data: makePRInfo({ number: 99, checksStatus: 'success' }), fetchedAt: 2 }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'success',
      reviewNumber: 99,
      reviewLabel: '#99'
    })
  })

  it('does not use stale merged branch PR cache after the worktree advances', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({
      id: 'repo-1::/feature',
      linkedPR: null,
      head: 'new-head'
    })
    const cacheKey = getGitHubPRCacheKey(repo.path, repo.id, 'feature', settings)

    expect(
      makeProjection({
        worktree,
        repo,
        prCache: {
          [cacheKey]: {
            data: makePRInfo({
              number: 99,
              state: 'merged',
              headSha: 'merged-head'
            }),
            fetchedAt: 2
          }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'notFetched',
      reviewLabel: null
    })
  })

  it('does not use stale merged linked PR cache after the worktree advances', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({
      id: 'repo-1::/feature',
      linkedPR: 99,
      head: 'new-head'
    })
    const cacheKey = getGitHubPRCacheKey(repo.path, repo.id, 'feature', settings)

    expect(
      makeProjection({
        worktree,
        repo,
        prCache: {
          [cacheKey]: {
            data: makePRInfo({
              number: 99,
              title: 'Stale merged linked PR',
              state: 'merged',
              headSha: 'merged-head'
            }),
            fetchedAt: 2
          }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'linkedDetailsUnavailable',
      reviewNumber: 99,
      reviewLabel: '#99',
      title: 'Loading PR...'
    })
  })

  it('does not let older linked PR cache override a newer hosted-review miss', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({
      id: 'repo-1::/feature',
      linkedPR: 99
    })
    const hostedKey = getHostedReviewCacheKey(repo.path, 'feature', settings, repo.id)
    const prKey = getGitHubPRCacheKey(repo.path, repo.id, 'feature', settings)

    expect(
      makeProjection({
        worktree,
        repo,
        hostedReviewCache: {
          [hostedKey]: { data: null, fetchedAt: 3 }
        },
        prCache: {
          [prKey]: {
            data: makePRInfo({
              number: 99,
              title: 'Older linked PR cache'
            }),
            fetchedAt: 2
          }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'linkedDetailsUnavailable',
      reviewNumber: 99,
      reviewLabel: '#99',
      title: 'PR details unavailable'
    })
  })

  it('does not let mismatched hosted-review cache override linked PR metadata', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({
      id: 'repo-1::/feature',
      linkedPR: 99
    })
    const hostedKey = getHostedReviewCacheKey(repo.path, 'feature', settings, repo.id)

    expect(
      makeProjection({
        worktree,
        repo,
        hostedReviewCache: {
          [hostedKey]: {
            data: makeReview({
              number: 12,
              title: 'Stale branch review',
              status: 'failure'
            }),
            fetchedAt: 2,
            linkedReviewHintKey: 'github:12'
          }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'linkedDetailsUnavailable',
      reviewNumber: 99,
      reviewLabel: '#99',
      title: 'Loading PR...'
    })
  })

  it('does not use stale merged hosted-review cache after the worktree advances', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({
      id: 'repo-1::/feature',
      linkedPR: null,
      head: 'new-head'
    })
    const hostedKey = getHostedReviewCacheKey(repo.path, 'feature', settings, repo.id)

    expect(
      makeProjection({
        worktree,
        repo,
        hostedReviewCache: {
          [hostedKey]: {
            data: makeReview({
              number: 99,
              title: 'Stale merged hosted review',
              state: 'merged',
              headSha: 'merged-head'
            }),
            fetchedAt: 2,
            linkedReviewHintKey: ''
          }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'notFetched',
      reviewLabel: null
    })
  })

  it('does not use stale merged non-GitHub hosted-review cache after the worktree advances', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({
      id: 'repo-1::/feature',
      linkedBitbucketPR: null,
      head: 'new-head'
    })
    const hostedKey = getHostedReviewCacheKey(repo.path, 'feature', settings, repo.id)

    expect(
      makeProjection({
        worktree,
        repo,
        hostedReviewCache: {
          [hostedKey]: {
            data: makeReview({
              provider: 'bitbucket',
              number: 77,
              title: 'Stale merged Bitbucket PR',
              state: 'merged',
              headSha: 'merged-head'
            }),
            fetchedAt: 2,
            linkedReviewHintKey: ''
          }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'notFetched',
      reviewLabel: null
    })
  })

  it('does not let same-number hosted-review cache from another provider override linked PR metadata', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({
      id: 'repo-1::/feature',
      linkedPR: 99
    })
    const hostedKey = getHostedReviewCacheKey(repo.path, 'feature', settings, repo.id)

    expect(
      makeProjection({
        worktree,
        repo,
        hostedReviewCache: {
          [hostedKey]: {
            data: makeReview({
              provider: 'gitlab',
              number: 99,
              title: 'Wrong provider same number',
              status: 'failure'
            }),
            fetchedAt: 2,
            linkedReviewHintKey: ''
          }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'linkedDetailsUnavailable',
      provider: 'github',
      reviewNumber: 99,
      reviewLabel: '#99',
      title: 'Loading PR...'
    })
  })

  it('does not use linked-hint hosted-review cache after a non-GitHub link is removed', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({
      id: 'repo-1::/feature',
      linkedBitbucketPR: null
    })
    const hostedKey = getHostedReviewCacheKey(repo.path, 'feature', settings, repo.id)

    expect(
      makeProjection({
        worktree,
        repo,
        hostedReviewCache: {
          [hostedKey]: {
            data: makeReview({
              provider: 'bitbucket',
              number: 77,
              title: 'Removed linked Bitbucket PR'
            }),
            fetchedAt: 2,
            linkedReviewHintKey: 'bitbucket:77'
          }
        }
      }).rows[0]
    ).toMatchObject({
      status: 'notFetched',
      reviewLabel: null
    })
  })

  it('classifies completed unavailable refreshes as unavailable instead of not fetched', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({ id: 'repo-1::/feature' })
    const identity = getParentPrChecksRefreshIdentity(worktree, repo, 'feature')

    const projection = makeProjection({
      worktree,
      repo,
      refreshOutcomes: new Map([[identity, { kind: 'unavailable' }]])
    })

    expect(projection.rows[0]).toMatchObject({
      status: 'unavailable',
      group: 'unavailable',
      summary: 'Review status unavailable'
    })
    expect(projection.summary.unknown).toBe(1)
  })

  it('keeps linked unavailable and refresh-error rows out of No PR', () => {
    const repo = makeRepo()
    const linked = makeWorktree({ id: 'repo-1::/linked', linkedGitLabMR: 42 })
    const identity = getParentPrChecksRefreshIdentity(linked, repo, 'feature')

    const linkedUnavailable = makeProjection({ worktree: linked, repo })
    expect(linkedUnavailable.rows[0]).toMatchObject({
      status: 'linkedDetailsUnavailable',
      reviewLabel: '!42'
    })
    expect(linkedUnavailable.summary.noPr).toBe(0)

    const refreshError = makeProjection({
      worktree: linked,
      repo,
      refreshOutcomes: new Map([[identity, { kind: 'error' }]])
    })
    expect(refreshError.rows[0]?.status).toBe('refreshError')
    expect(refreshError.summary.noPr).toBe(0)
  })

  it('preserves stale review grouping when a refresh fails', () => {
    const repo = makeRepo()
    const worktree = makeWorktree({ id: 'repo-1::/feature' })
    const cacheKey = getHostedReviewCacheKey(repo.path, 'feature', settings, repo.id)
    const identity = getParentPrChecksRefreshIdentity(worktree, repo, 'feature')

    const projection = makeProjection({
      worktree,
      repo,
      hostedReviewCache: {
        [cacheKey]: {
          data: makeReview({ status: 'success' }),
          fetchedAt: 1,
          linkedReviewHintKey: ''
        }
      },
      refreshOutcomes: new Map([[identity, { kind: 'error' }]])
    })

    expect(projection.rows[0]).toMatchObject({
      status: 'success',
      group: 'passing',
      summary: 'Checks passing'
    })
    expect(projection.summary.passing).toBe(1)
  })

  it('reads scoped GitHub checks detail names without using details as aggregate truth', () => {
    const repo = makeRepo({ connectionId: 'ssh-1' })
    const worktree = makeWorktree({ id: 'repo-1::/feature' })
    const review = makeReview({ status: 'failure', headSha: 'abc123' })
    const hostedKey = getHostedReviewCacheKey(
      repo.path,
      'feature',
      settings,
      repo.id,
      repo.connectionId
    )
    const checksKey = getGitHubRepoCacheKey(
      repo.path,
      repo.id,
      prChecksCacheSuffix(12, null, 'abc123'),
      settings,
      repo.connectionId
    )

    const projection = makeProjection({
      worktree,
      repo,
      hostedReviewCache: { [hostedKey]: { data: review, fetchedAt: 1, linkedReviewHintKey: '' } },
      checksCache: {
        [checksKey]: {
          data: [
            {
              name: 'build',
              status: 'completed',
              conclusion: 'failure',
              url: null
            }
          ],
          fetchedAt: 1,
          headSha: 'abc123'
        }
      }
    })

    expect(projection.rows[0]?.detailNames).toEqual(['build'])
    expect(projection.rows[0]?.status).toBe('failing')
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
