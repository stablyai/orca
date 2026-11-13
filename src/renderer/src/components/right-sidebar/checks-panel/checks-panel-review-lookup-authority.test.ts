import { describe, expect, it } from 'vitest'
import { normalizeTrustedReviewUrl } from './checks-panel-review-lookup-authority'

describe('normalizeTrustedReviewUrl', () => {
  it('rejects credential-bearing URLs so tokens never reach the browser/shell', () => {
    expect(normalizeTrustedReviewUrl('https://user:token@git.test/repo/pull/1')).toBe(null)
    expect(normalizeTrustedReviewUrl('https://user@git.test/repo/pull/1')).toBe(null)
  })
})

describe('resolveChecksPanelReviewLookup with a durable link', () => {
  it('names the linked PR and opens only a URL for that number', async () => {
    const { resolveChecksPanelReviewLookup } =
      await import('./checks-panel-review-lookup-authority')
    const { selectUsableGitHubPR } = await import('./checks-panel-review')
    const cachedPR = {
      number: 5,
      title: 'Other',
      state: 'open' as const,
      url: 'https://github.com/acme/widgets/pull/5',
      checksStatus: 'success' as const,
      updatedAt: '2026-11-01T00:00:00Z',
      mergeable: 'MERGEABLE' as const
    }
    const pr = selectUsableGitHubPR({
      hostedReview: null,
      pr: cachedPR,
      linkedPR: 7,
      suppressedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
    expect(pr).toBeNull()

    const result = resolveChecksPanelReviewLookup({
      pr,
      prCachedHasPR: true,
      hostedReview: {
        provider: 'github',
        number: 5,
        url: 'https://github.com/acme/widgets/pull/5'
      },
      linkedReviewNumber: 7,
      eligibilityReviewLookupOutcome: 'found',
      eligibilityReview: { number: 7, url: 'https://github.com/acme/widgets/pull/7' },
      isGitHub: true
    })
    expect(result).toEqual({
      state: 'positive_unresolved',
      reviewNumber: 7,
      openReviewUrl: 'https://github.com/acme/widgets/pull/7'
    })

    expect(
      resolveChecksPanelReviewLookup({
        pr: null,
        prCachedHasPR: true,
        hostedReview: {
          provider: 'github',
          number: 5,
          url: 'https://github.com/acme/widgets/pull/5'
        },
        linkedReviewNumber: 7,
        isGitHub: true
      }).openReviewUrl
    ).toBeNull()
  })
})
