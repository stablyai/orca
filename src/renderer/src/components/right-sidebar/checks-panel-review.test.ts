import { describe, expect, it } from 'vitest'
import { gitHubPRToChecksPanelReview, selectChecksPanelReview } from './checks-panel-review'
import type { PRInfo } from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    title: 'Add merge queue support',
    state: 'open',
    url: 'https://github.com/acme/web/pull/42',
    checksStatus: 'success',
    updatedAt: '2026-06-02T00:00:00Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

function makeGitLabReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'gitlab',
    number: 9,
    title: 'GitLab MR',
    state: 'open',
    url: 'https://gitlab.com/acme/widgets/-/merge_requests/9',
    status: 'pending',
    updatedAt: '2026-06-02T00:00:00Z',
    mergeable: 'UNKNOWN',
    ...overrides
  }
}

describe('gitHubPRToChecksPanelReview', () => {
  // Why: the right-sidebar merge presenter reads these fields off the converted
  // review object. PR #4001 dropped them here, so review-required/merge-queue
  // PRs silently rendered as plain "Able to merge" (regressing PR #2856).
  it('propagates review and merge-queue metadata from the PR', () => {
    const review = gitHubPRToChecksPanelReview(
      makePR({
        reviewDecision: 'REVIEW_REQUIRED',
        mergeQueueRequired: true,
        mergeStateStatus: 'BLOCKED',
        autoMergeEnabled: true,
        autoMergeAllowed: false
      })
    )

    expect(review.reviewDecision).toBe('REVIEW_REQUIRED')
    expect(review.mergeQueueRequired).toBe(true)
    expect(review.mergeStateStatus).toBe('BLOCKED')
    expect(review.autoMergeEnabled).toBe(true)
    expect(review.autoMergeAllowed).toBe(false)
  })

  it('carries the base identity fields', () => {
    const review = gitHubPRToChecksPanelReview(makePR({ headSha: 'abc123' }))
    expect(review.provider).toBe('github')
    expect(review.number).toBe(42)
    expect(review.status).toBe('success')
    expect(review.headSha).toBe('abc123')
  })
})

describe('selectChecksPanelReview', () => {
  it('uses GitLab hosted review metadata ahead of GitHub PR cache', () => {
    const review = makeGitLabReview({ number: 34 })

    expect(
      selectChecksPanelReview({
        hostedReview: review,
        pr: makePR({ number: 12 }),
        linkedGitLabMR: 34,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null
      })
    ).toBe(review)
  })

  it('uses GitHub PR cache when no non-GitHub review is linked', () => {
    const selected = selectChecksPanelReview({
      hostedReview: null,
      pr: makePR({ number: 12, state: 'merged' }),
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })

    expect(selected).toMatchObject({ provider: 'github', number: 12, state: 'merged' })
  })

  it.each([
    { provider: 'GitLab', linkedGitLabMR: 7 },
    { provider: 'Bitbucket', linkedBitbucketPR: 8 },
    { provider: 'Azure DevOps', linkedAzureDevOpsPR: 9 },
    { provider: 'Gitea', linkedGiteaPR: 10 }
  ])('does not surface GitHub PR cache when a $provider review is linked', (links) => {
    expect(
      selectChecksPanelReview({
        hostedReview: null,
        pr: makePR({ number: 12, state: 'merged' }),
        linkedGitLabMR: links.linkedGitLabMR ?? null,
        linkedBitbucketPR: links.linkedBitbucketPR ?? null,
        linkedAzureDevOpsPR: links.linkedAzureDevOpsPR ?? null,
        linkedGiteaPR: links.linkedGiteaPR ?? null
      })
    ).toBeNull()
  })
})
