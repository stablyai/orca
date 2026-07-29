import { describe, expect, it } from 'vitest'
import {
  getChecksPanelForegroundReviewEvidenceKey,
  resolveChecksPanelPRRefreshRequest,
  resolveChecksPanelReviewEvidenceProvider
} from './checks-panel-pr-refresh-request'

describe('resolveChecksPanelReviewEvidenceProvider', () => {
  const noLinkedReviews = {
    linkedGitHubPR: null,
    linkedGitLabMR: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null
  }

  it.each([
    ['linkedGitHubPR', 'github'],
    ['linkedGitLabMR', 'gitlab'],
    ['linkedBitbucketPR', 'bitbucket'],
    ['linkedAzureDevOpsPR', 'azure-devops'],
    ['linkedGiteaPR', 'gitea']
  ] as const)('lets an explicit %s link outrank stale cached metadata', (linkedField, provider) => {
    expect(
      resolveChecksPanelReviewEvidenceProvider({
        ...noLinkedReviews,
        [linkedField]: 42,
        cachedProvider: 'unsupported'
      })
    ).toBe(provider)
  })

  it('uses eligibility before cached provider metadata when no review is linked', () => {
    expect(
      resolveChecksPanelReviewEvidenceProvider({
        ...noLinkedReviews,
        eligibilityProvider: 'bitbucket',
        cachedProvider: 'gitlab'
      })
    ).toBe('bitbucket')
  })
})

describe('getChecksPanelForegroundReviewEvidenceKey', () => {
  const input = {
    refreshContextKey: 'worktree::cache::branch',
    reviewEvidenceIdentity: 42,
    hasUnrenderedReviewEvidence: true,
    isGitHubReviewContext: true
  } as const

  it('keeps optimistic and confirmed GitHub evidence on one request key', () => {
    const optimisticKey = getChecksPanelForegroundReviewEvidenceKey(input)
    const confirmedKey = getChecksPanelForegroundReviewEvidenceKey({
      ...input,
      reviewEvidenceProvider: 'github'
    })
    expect(optimisticKey).toBe('worktree::cache::branch::github::42')
    expect(confirmedKey).toBe(optimisticKey)
  })

  it('clears the request key when evidence switches to another provider', () => {
    expect(
      getChecksPanelForegroundReviewEvidenceKey({
        ...input,
        reviewEvidenceProvider: 'gitlab'
      })
    ).toBeNull()
  })
})

describe('resolveChecksPanelPRRefreshRequest', () => {
  it('uses an active refresh for a cached miss from before the checks panel became visible', () => {
    expect(
      resolveChecksPanelPRRefreshRequest({
        cachedHasPR: false,
        cachedFetchedAt: 100,
        panelVisibleSince: 200
      })
    ).toEqual({ reason: 'active', priority: 80 })
  })

  it('keeps fresh empty lookups on the background path', () => {
    expect(
      resolveChecksPanelPRRefreshRequest({
        cachedHasPR: false,
        cachedFetchedAt: 200,
        panelVisibleSince: 100
      })
    ).toEqual({ reason: 'swr', priority: 30 })
  })

  it('foreground-fetches a known-but-unrendered review so the panel resolves off the transient card', () => {
    expect(
      resolveChecksPanelPRRefreshRequest({
        cachedHasPR: null,
        cachedFetchedAt: null,
        panelVisibleSince: 200,
        hasUnrenderedReviewEvidence: true
      })
    ).toEqual({ reason: 'active', priority: 80 })
  })

  it('does not repeatedly force provider work for the same unrendered review evidence', () => {
    expect(
      resolveChecksPanelPRRefreshRequest({
        cachedHasPR: false,
        cachedFetchedAt: 100,
        panelVisibleSince: 200,
        hasUnrenderedReviewEvidence: true,
        hasRequestedForegroundRefresh: true
      })
    ).toEqual({ reason: 'swr', priority: 30 })
  })

  it('does not force provider work when review details are already cached', () => {
    expect(
      resolveChecksPanelPRRefreshRequest({
        cachedHasPR: true,
        cachedFetchedAt: 100,
        panelVisibleSince: 200,
        hasUnrenderedReviewEvidence: true
      })
    ).toEqual({ reason: 'swr', priority: 30 })
  })

  it('keeps populated or unknown cache entries on the background path', () => {
    expect(
      resolveChecksPanelPRRefreshRequest({
        cachedHasPR: true,
        cachedFetchedAt: 100,
        panelVisibleSince: 200
      })
    ).toEqual({ reason: 'swr', priority: 30 })

    expect(
      resolveChecksPanelPRRefreshRequest({
        cachedHasPR: null,
        cachedFetchedAt: null,
        panelVisibleSince: 200
      })
    ).toEqual({ reason: 'swr', priority: 30 })
  })
})
