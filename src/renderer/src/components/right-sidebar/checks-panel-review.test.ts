import { describe, expect, it } from 'vitest'
import { gitHubPRToChecksPanelReview, selectChecksPanelReview } from './checks-panel-review'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
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
        linkedPR: null,
        suppressedGitHubPR: null,
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
      linkedPR: null,
      suppressedGitHubPR: null,
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
        linkedPR: null,
        suppressedGitHubPR: null,
        linkedGitLabMR: links.linkedGitLabMR ?? null,
        linkedBitbucketPR: links.linkedBitbucketPR ?? null,
        linkedAzureDevOpsPR: links.linkedAzureDevOpsPR ?? null,
        linkedGiteaPR: links.linkedGiteaPR ?? null
      })
    ).toBeNull()
  })

  it('hides a matching suppressed GitHub PR', () => {
    expect(
      selectChecksPanelReview({
        hostedReview: null,
        pr: makePR({ number: 12 }),
        linkedPR: null,
        suppressedGitHubPR: 12,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null
      })
    ).toBeNull()
  })

  it('does not substitute a stale branch PR for an explicit GitHub link', () => {
    expect(
      selectChecksPanelReview({
        hostedReview: null,
        pr: makePR({ number: 43 }),
        linkedPR: 42,
        suppressedGitHubPR: null,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null
      })
    ).toBeNull()
  })

  it('keeps a different detected PR and lets an explicit link override stale suppression', () => {
    const common = {
      hostedReview: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    }

    expect(
      selectChecksPanelReview({
        ...common,
        pr: makePR({ number: 13 }),
        linkedPR: null,
        suppressedGitHubPR: 12
      })
    ).toMatchObject({ provider: 'github', number: 13 })
    expect(
      selectChecksPanelReview({
        ...common,
        pr: makePR({ number: 12 }),
        linkedPR: 12,
        suppressedGitHubPR: 12
      })
    ).toMatchObject({ provider: 'github', number: 12 })
  })
})
