import { describe, expect, it } from 'vitest'

import { getGitHubPRReviewStatus } from './pr-reviewer-display'

describe('GitHub PR review status', () => {
  it('names the reviewers behind the review decision', () => {
    const latestReviews = [
      { login: 'alice', state: 'APPROVED' },
      { login: 'review-bot', state: 'APPROVED' },
      { login: 'carol', state: 'DISMISSED' }
    ]

    expect(getGitHubPRReviewStatus({ reviewDecision: 'APPROVED', latestReviews })).toEqual({
      kind: 'approved',
      logins: ['alice', 'review-bot']
    })
    expect(
      getGitHubPRReviewStatus({
        reviewDecision: 'CHANGES_REQUESTED',
        latestReviews: [...latestReviews, { login: 'bob', state: 'CHANGES_REQUESTED' }]
      })
    ).toEqual({ kind: 'changesRequested', logins: ['bob'] })
    expect(
      getGitHubPRReviewStatus({ reviewDecision: 'REVIEW_REQUIRED', latestReviews: [] })
    ).toEqual({ kind: 'reviewRequired', logins: [] })
    expect(getGitHubPRReviewStatus({ reviewDecision: null, latestReviews })).toEqual({
      kind: 'approved',
      logins: ['alice', 'review-bot']
    })
    expect(
      getGitHubPRReviewStatus({
        reviewDecision: 'APPROVED',
        latestReviews: [...latestReviews, { login: 'outsider', state: 'CHANGES_REQUESTED' }]
      })
    ).toEqual({ kind: 'approved', logins: ['alice', 'review-bot'] })
    expect(
      getGitHubPRReviewStatus({
        reviewDecision: null,
        latestReviews: [...latestReviews, { login: 'bob', state: 'CHANGES_REQUESTED' }]
      })
    ).toEqual({ kind: 'changesRequested', logins: ['bob'] })
    expect(getGitHubPRReviewStatus({ reviewDecision: null, latestReviews: [] })).toBeNull()
  })
})
