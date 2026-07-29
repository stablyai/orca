import { describe, expect, it } from 'vitest'
import {
  isRenderableChecksPanelReviewDetails,
  normalizeTrustedReviewUrl,
  resolveChecksPanelReviewLookup
} from './checks-panel-review-lookup-authority'

const EMPTY = {
  pr: null,
  prCachedHasPR: null,
  hostedReview: null
} as const

describe('resolveChecksPanelReviewLookup', () => {
  it('returns found with a trusted URL when PR details are renderable', () => {
    expect(
      resolveChecksPanelReviewLookup({
        ...EMPTY,
        pr: { number: 42, url: 'https://github.com/o/r/pull/42' }
      })
    ).toEqual({ state: 'found', openReviewUrl: 'https://github.com/o/r/pull/42' })
  })

  it('does not treat a summary without a positive number as found', () => {
    expect(
      resolveChecksPanelReviewLookup({
        ...EMPTY,
        pr: { number: 0, url: 'https://github.com/o/r/pull/0' },
        hostedReview: { provider: 'github', url: 'https://github.com/o/r/pull/1', number: 1 }
      }).state
    ).toBe('positive_unresolved')
  })

  it('classifies a github hosted-review card with no PR cache as positive_unresolved', () => {
    // Replaces the old hasAmbiguousGitHubHostedReview boolean.
    expect(
      resolveChecksPanelReviewLookup({
        ...EMPTY,
        prCachedHasPR: null,
        hostedReview: { provider: 'github', number: 7, url: 'https://github.com/o/r/pull/7' }
      })
    ).toEqual({ state: 'positive_unresolved', openReviewUrl: 'https://github.com/o/r/pull/7' })
  })

  it('keeps positive evidence over an accepted null no-PR entry (conflict)', () => {
    expect(
      resolveChecksPanelReviewLookup({
        ...EMPTY,
        prCachedHasPR: false,
        linkedReviewNumber: 5
      }).state
    ).toBe('positive_unresolved')
  })

  it('returns not_found for an accepted no-PR cache entry', () => {
    expect(resolveChecksPanelReviewLookup({ ...EMPTY, prCachedHasPR: false })).toEqual({
      state: 'not_found',
      openReviewUrl: null
    })
  })

  it('returns not_found for eligibility not_found', () => {
    expect(
      resolveChecksPanelReviewLookup({
        ...EMPTY,
        eligibilityReviewLookupOutcome: 'not_found'
      }).state
    ).toBe('not_found')
  })

  it('treats eligibility found as positive_unresolved when no renderable details', () => {
    expect(
      resolveChecksPanelReviewLookup({
        ...EMPTY,
        eligibilityReviewLookupOutcome: 'found',
        eligibilityReview: { url: 'https://gitlab.com/o/r/-/merge_requests/3' }
      })
    ).toEqual({
      state: 'positive_unresolved',
      openReviewUrl: 'https://gitlab.com/o/r/-/merge_requests/3'
    })
  })

  it('returns unknown for a missing entry and unavailable eligibility', () => {
    expect(
      resolveChecksPanelReviewLookup({
        ...EMPTY,
        prCachedHasPR: null,
        eligibilityReviewLookupOutcome: 'unavailable'
      }).state
    ).toBe('unknown')
  })

  it('does not offer Open Review for a non-http url', () => {
    expect(
      resolveChecksPanelReviewLookup({
        ...EMPTY,
        hostedReview: { provider: 'github', number: 9, url: 'javascript:alert(1)' }
      })
    ).toEqual({ state: 'positive_unresolved', openReviewUrl: null })
  })
})

describe('normalizeTrustedReviewUrl', () => {
  it('accepts http and https', () => {
    expect(normalizeTrustedReviewUrl(' https://x.test/pull/1 ')).toBe('https://x.test/pull/1')
    expect(normalizeTrustedReviewUrl('http://x.test/pull/1')).toBe('http://x.test/pull/1')
  })

  it('rejects empty and non-web schemes', () => {
    expect(normalizeTrustedReviewUrl(null)).toBe(null)
    expect(normalizeTrustedReviewUrl('')).toBe(null)
    expect(normalizeTrustedReviewUrl('ftp://x.test')).toBe(null)
    expect(normalizeTrustedReviewUrl('file:///etc/passwd')).toBe(null)
    expect(normalizeTrustedReviewUrl('not a url')).toBe(null)
  })

  it('rejects credential-bearing URLs so tokens never reach the browser/shell', () => {
    expect(normalizeTrustedReviewUrl('https://user:token@git.test/repo/pull/1')).toBe(null)
    expect(normalizeTrustedReviewUrl('https://user@git.test/repo/pull/1')).toBe(null)
  })
})

describe('isRenderableChecksPanelReviewDetails', () => {
  it('requires a positive number', () => {
    expect(isRenderableChecksPanelReviewDetails({ number: 1 })).toBe(true)
    expect(isRenderableChecksPanelReviewDetails({ number: 0 })).toBe(false)
    expect(isRenderableChecksPanelReviewDetails(null)).toBe(false)
  })
})
