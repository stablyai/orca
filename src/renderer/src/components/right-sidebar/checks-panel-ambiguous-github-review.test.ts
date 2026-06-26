import { describe, expect, it } from 'vitest'
import { hasAmbiguousGitHubHostedReviewForChecksPanel } from './checks-panel-ambiguous-github-review'

describe('hasAmbiguousGitHubHostedReviewForChecksPanel', () => {
  it('treats missing PR cache as ambiguous when a GitHub hosted review exists', () => {
    expect(
      hasAmbiguousGitHubHostedReviewForChecksPanel({
        hostedReview: { provider: 'github' },
        prCacheEntry: undefined,
        prCacheKey: 'repo::feature'
      })
    ).toBe(true)
  })

  it('treats cached no-PR data as ambiguous when a GitHub hosted review exists', () => {
    expect(
      hasAmbiguousGitHubHostedReviewForChecksPanel({
        hostedReview: { provider: 'github' },
        prCacheEntry: { data: null },
        prCacheKey: 'repo::feature'
      })
    ).toBe(true)
  })

  it('does not treat existing PR cache data as ambiguous', () => {
    expect(
      hasAmbiguousGitHubHostedReviewForChecksPanel({
        hostedReview: { provider: 'github' },
        prCacheEntry: { data: { number: 12 } },
        prCacheKey: 'repo::feature'
      })
    ).toBe(false)
  })

  it('does not treat non-GitHub hosted reviews as ambiguous', () => {
    expect(
      hasAmbiguousGitHubHostedReviewForChecksPanel({
        hostedReview: { provider: 'gitlab' },
        prCacheEntry: { data: null },
        prCacheKey: 'repo::feature'
      })
    ).toBe(false)
  })
})
