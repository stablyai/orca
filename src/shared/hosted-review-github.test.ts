import { describe, expect, it } from 'vitest'
import { hostedReviewSummaryFromGitHubPRInfo } from './hosted-review-github'
import type { PRInfo } from './types'

const pr: PRInfo = {
  number: 12,
  title: 'Add queue badges',
  state: 'open',
  url: 'https://github.com/acme/orca/pull/12',
  checksStatus: 'pending',
  updatedAt: '2026-05-12T00:00:00.000Z',
  mergeable: 'MERGEABLE',
  headSha: 'abc123'
}

describe('hostedReviewSummaryFromGitHubPRInfo', () => {
  it('maps PRInfo into provider-neutral summary with host identity', () => {
    const summary = hostedReviewSummaryFromGitHubPRInfo({
      pr,
      owner: 'acme',
      repo: 'orca',
      host: 'github.acme.internal'
    })

    expect(summary.identity).toEqual({
      provider: 'github',
      host: 'github.acme.internal',
      owner: 'acme',
      repo: 'orca',
      number: 12
    })
    expect(summary.checksStatus).toBe('pending')
    expect(summary.threadSummary).toBeUndefined()
  })

  it('derives unresolved thread count and failing status from enrichers', () => {
    const summary = hostedReviewSummaryFromGitHubPRInfo({
      pr: { ...pr, checksStatus: 'success' },
      owner: 'acme',
      repo: 'orca',
      comments: [
        {
          id: 1,
          author: 'a',
          authorAvatarUrl: '',
          body: '',
          createdAt: '',
          url: '',
          threadId: 't1',
          isResolved: false
        },
        {
          id: 2,
          author: 'b',
          authorAvatarUrl: '',
          body: '',
          createdAt: '',
          url: '',
          threadId: 't1',
          isResolved: false
        },
        {
          id: 3,
          author: 'c',
          authorAvatarUrl: '',
          body: '',
          createdAt: '',
          url: '',
          threadId: 't2',
          isResolved: true
        }
      ],
      checks: [{ name: 'ci', status: 'completed', conclusion: 'failure', url: null }]
    })

    expect(summary.threadSummary).toEqual({ unresolvedCount: 1, dataCompleteness: 'partial' })
    expect(summary.checksStatus).toBe('failure')
  })

  it('distinguishes loaded empty comments from unknown comments', () => {
    expect(
      hostedReviewSummaryFromGitHubPRInfo({
        pr,
        owner: 'acme',
        repo: 'orca'
      }).threadSummary
    ).toBeUndefined()

    expect(
      hostedReviewSummaryFromGitHubPRInfo({
        pr,
        owner: 'acme',
        repo: 'orca',
        comments: []
      }).threadSummary
    ).toEqual({ unresolvedCount: 0, dataCompleteness: 'partial' })
  })
})
