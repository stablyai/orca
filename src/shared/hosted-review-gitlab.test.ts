import { describe, expect, it } from 'vitest'
import { hostedReviewSummaryFromGitLabInfo } from './hosted-review-gitlab'
import type { HostedReviewInfo } from './hosted-review'

const review: HostedReviewInfo & { provider: 'gitlab' } = {
  provider: 'gitlab',
  number: 12,
  title: 'Add queue badges',
  state: 'open',
  url: 'https://gitlab.acme.internal/group/subgroup/orca/-/merge_requests/12',
  status: 'pending',
  updatedAt: '2026-05-12T00:00:00.000Z',
  mergeable: 'MERGEABLE'
}

describe('hostedReviewSummaryFromGitLabInfo', () => {
  it('maps nested GitLab project URLs into provider-neutral identity', () => {
    const summary = hostedReviewSummaryFromGitLabInfo({ review })

    expect(summary.identity).toEqual({
      provider: 'gitlab',
      host: 'gitlab.acme.internal',
      owner: 'group/subgroup',
      repo: 'orca',
      number: 12
    })
    expect(summary.checksStatus).toBe('pending')
    expect(summary.threadSummary).toBeUndefined()
  })

  it('derives unresolved thread count and failing status from enrichers', () => {
    const summary = hostedReviewSummaryFromGitLabInfo({
      review: { ...review, status: 'success' },
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
      checks: [{ name: 'gitlab-ci', status: 'completed', conclusion: 'failure', url: null }]
    })

    expect(summary.threadSummary).toEqual({ unresolvedCount: 1, dataCompleteness: 'partial' })
    expect(summary.checksStatus).toBe('failure')
  })
})
