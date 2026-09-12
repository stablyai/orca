import { describe, expect, it } from 'vitest'
import { formatHostedReviewLabel, formatReviewState } from './hosted-review-label'

describe('formatReviewState', () => {
  it('capitalizes the first letter', () => {
    expect(formatReviewState('open')).toBe('Open')
    expect(formatReviewState('merged')).toBe('Merged')
  })
})

describe('formatHostedReviewLabel', () => {
  it('labels a GitLab review as "MR !N" — not "PR #N"', () => {
    expect(
      formatHostedReviewLabel({ provider: 'gitlab', number: 5, state: 'open', status: 'none' })
    ).toBe('MR !5 Open')
  })

  it('labels a GitHub review as "PR #N"', () => {
    expect(
      formatHostedReviewLabel({ provider: 'github', number: 42, state: 'open', status: 'none' })
    ).toBe('PR #42 Open')
  })

  it.each([
    ['azure-devops' as const, 'PR #7 Open'],
    ['gitea' as const, 'PR #7 Open']
  ])('uses the "PR #" form and correct copy for %s', (provider, expected) => {
    expect(formatHostedReviewLabel({ provider, number: 7, state: 'open', status: 'none' })).toBe(
      expected
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
