import { describe, expect, it } from 'vitest'
import { formatHostedReviewLabel } from './hosted-review-label'

describe('formatHostedReviewLabel', () => {
  it('labels a GitLab review as "MR !N" — not "PR #N"', () => {
    expect(
      formatHostedReviewLabel({ provider: 'gitlab', number: 5, state: 'open', status: 'none' })
    ).toBe('MR !5 Open')
  })

  it.each([
    ['github' as const, 'PR #7 Open'],
    ['azure-devops' as const, 'PR #7 Open'],
    ['gitea' as const, 'PR #7 Open'],
    ['bitbucket' as const, 'PR #7 Open']
  ])('uses the "PR #" form and correct copy for %s', (provider, expected) => {
    expect(formatHostedReviewLabel({ provider, number: 7, state: 'open', status: 'none' })).toBe(
      expected
    )
  })

  it('keeps the GitHub label for older cached reviews without a provider', () => {
    expect(formatHostedReviewLabel({ number: 42, state: 'open', status: 'none' })).toBe(
      'PR #42 Open'
    )
  })

  it('appends a non-"none" status suffix', () => {
    expect(
      formatHostedReviewLabel({ provider: 'gitlab', number: 5, state: 'open', status: 'draft' })
    ).toBe('MR !5 Open, draft')
  })

  it('omits the suffix when status is "none" or empty', () => {
    expect(
      formatHostedReviewLabel({ provider: 'github', number: 5, state: 'closed', status: '' })
    ).toBe('PR #5 Closed')
  })
})
