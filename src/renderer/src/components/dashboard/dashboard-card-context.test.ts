import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import {
  resolveDashboardCardContext,
  type DashboardCardContextState
} from './dashboard-card-context'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#fff',
  addedAt: 1,
  kind: 'git'
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'worktree-1',
    repoId: repo.id,
    path: '/repo/worktree',
    head: 'current-head',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function review(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'bitbucket',
    number: 77,
    title: 'Review',
    state: 'open',
    url: 'https://example.test/review/77',
    status: 'success',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

function state(
  cachedReview: HostedReviewInfo,
  linkedReviewHintKey: string
): DashboardCardContextState {
  const cacheKey = getHostedReviewCacheKey(repo.path, 'feature', null, repo.id, null, null, true)
  return {
    settings: null,
    hostedReviewCache: {
      [cacheKey]: { data: cachedReview, fetchedAt: 1, linkedReviewHintKey }
    },
    prCache: {}
  }
}

describe('resolveDashboardCardContext', () => {
  it.each([
    ['bitbucket', { linkedBitbucketPR: 77 }],
    ['azure-devops', { linkedAzureDevOpsPR: 77 }],
    ['gitea', { linkedGiteaPR: 77 }]
  ] as const)('uses valid cached %s review metadata', (provider, link) => {
    expect(
      resolveDashboardCardContext(
        state(review({ provider }), `${provider}:77`),
        repo,
        worktree(link)
      ).review
      // The card's CI dot and its click target both ride along with the review.
    ).toEqual({
      number: 77,
      state: 'open',
      checksStatus: 'success',
      url: 'https://example.test/review/77'
    })
  })

  it('keeps validated GitHub PR cache metadata as a fallback', () => {
    const pr: PRInfo = {
      number: 42,
      title: 'GitHub review',
      state: 'draft',
      url: 'https://example.test/pull/42',
      checksStatus: 'pending',
      updatedAt: '2026-01-01T00:00:00.000Z',
      mergeable: 'UNKNOWN'
    }
    const cacheKey = getGitHubPRCacheKey(repo.path, repo.id, 'feature', null, null, null, true)

    expect(
      resolveDashboardCardContext(
        {
          settings: null,
          hostedReviewCache: {},
          prCache: { [cacheKey]: { data: pr, fetchedAt: 1 } }
        },
        repo,
        worktree({ linkedPR: 42 })
      ).review
    ).toEqual({
      number: 42,
      state: 'draft',
      checksStatus: 'pending',
      url: 'https://example.test/pull/42'
    })
  })

  it('rejects cached review metadata from the previous linked review', () => {
    expect(
      resolveDashboardCardContext(
        state(review({ number: 12 }), 'bitbucket:12'),
        repo,
        worktree({ linkedBitbucketPR: 13 })
      ).review
    ).toBeUndefined()
  })

  it('rejects a merged review after the worktree head advances', () => {
    expect(
      resolveDashboardCardContext(
        state(review({ state: 'merged', headSha: 'merged-head' }), ''),
        repo,
        worktree()
      ).review
    ).toBeUndefined()
  })
})

describe('resolveDashboardCardContext linked ticket', () => {
  it('links the ticket badge to Linear when the org key is known', () => {
    expect(
      resolveDashboardCardContext(
        {},
        repo,
        worktree({
          linkedLinearIssue: 'STA-335',
          linkedLinearIssueOrganizationUrlKey: 'acme'
        })
      ).linearIssue
    ).toEqual({ identifier: 'STA-335', url: 'https://linear.app/acme/issue/STA-335' })
  })

  it('still names the ticket when no org key is known, so the badge stays inert', () => {
    expect(
      resolveDashboardCardContext({}, repo, worktree({ linkedLinearIssue: 'STA-335' })).linearIssue
    ).toEqual({ identifier: 'STA-335' })
  })

  it('has no ticket when the workspace links none', () => {
    expect(resolveDashboardCardContext({}, repo, worktree()).linearIssue).toBeUndefined()
  })
})
