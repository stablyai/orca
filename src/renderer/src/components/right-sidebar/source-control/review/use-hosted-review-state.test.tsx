// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../../../shared/hosted-review'
import type { PRInfo } from '../../../../../../shared/github/pull-request-types'
import { useSourceControlHostedReviewState } from './use-hosted-review-state'

function makePR(number = 42): PRInfo {
  return {
    number,
    title: 'Detected pull request',
    state: 'open',
    url: `https://github.com/acme/orca/pull/${number}`,
    checksStatus: 'pending',
    updatedAt: '2026-08-27T00:00:00Z',
    mergeable: 'UNKNOWN'
  }
}

function renderState({
  pr = makePR(),
  hostedReviewEntryData = null,
  linkedPR = null,
  suppressedGitHubPR = null
}: {
  pr?: PRInfo | null
  hostedReviewEntryData?: HostedReviewInfo | null
  linkedPR?: number | null
  suppressedGitHubPR?: number | null
} = {}) {
  return renderHook(() =>
    useSourceControlHostedReviewState({
      activePrFromQueue: pr,
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      branchName: 'feature',
      hostedReviewCacheKey: 'cache-key',
      hostedReviewEntryData,
      linkedPR,
      suppressedGitHubPR
    })
  ).result.current
}

describe('useSourceControlHostedReviewState', () => {
  it('hides a matching suppressed PR and blocks duplicate creation', () => {
    const state = renderState({ suppressedGitHubPR: 42 })

    expect(state.hostedReview).toBeNull()
    expect(state.hasSuppressedGitHubPR).toBe(true)
    expect(state.hostedReviewCreation).toMatchObject({
      provider: 'github',
      canCreate: false,
      blockedReason: 'existing_review',
      review: { number: 42 }
    })
  })

  it('shows a different detected PR and lets an explicit link win', () => {
    expect(renderState({ pr: makePR(43), suppressedGitHubPR: 42 }).hostedReview?.number).toBe(43)
    expect(renderState({ linkedPR: 42, suppressedGitHubPR: 42 }).hostedReview?.number).toBe(42)
  })

  it('preserves non-GitHub reviews', () => {
    const gitLabReview: HostedReviewInfo = {
      provider: 'gitlab',
      number: 42,
      title: 'GitLab review',
      state: 'open',
      url: 'https://gitlab.com/acme/orca/-/merge_requests/42',
      status: 'pending',
      updatedAt: '2026-08-27T00:00:00Z',
      mergeable: 'UNKNOWN'
    }

    expect(
      renderState({
        pr: null,
        hostedReviewEntryData: gitLabReview,
        suppressedGitHubPR: 42
      }).hostedReview
    ).toBe(gitLabReview)
  })
})
