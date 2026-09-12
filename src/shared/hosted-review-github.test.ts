import { describe, expect, it } from 'vitest'
import { hostedReviewInfoFromGitHubPRInfo } from './hosted-review-github'
import type { PRInfo } from './github/pull-request-types'

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

describe('hostedReviewInfoFromGitHubPRInfo', () => {
  it('maps PRInfo into sidebar hosted review metadata', () => {
    const githubRepository = { owner: 'upstream', repo: 'orca' }
    const review = hostedReviewInfoFromGitHubPRInfo({ ...pr, prRepo: githubRepository })

    expect(review).toMatchObject({
      provider: 'github',
      number: 12,
      title: 'Add queue badges',
      state: 'open',
      status: 'pending',
      mergeable: 'MERGEABLE',
      headSha: 'abc123',
      githubRepository
    })
  })
})
