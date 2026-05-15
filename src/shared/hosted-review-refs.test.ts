import { describe, expect, it } from 'vitest'
import { normalizeHostedReviewBaseRef, normalizeHostedReviewHeadRef } from './hosted-review-refs'

describe('hosted review ref normalization', () => {
  it('normalizes local and remote head refs to branch names', () => {
    expect(normalizeHostedReviewHeadRef(' refs/heads/feature/create-pr ')).toBe('feature/create-pr')
    expect(normalizeHostedReviewHeadRef('refs/remotes/origin/feature/create-pr')).toBe(
      'feature/create-pr'
    )
  })

  it('strips common remote prefixes from base refs', () => {
    expect(normalizeHostedReviewBaseRef('origin/main')).toBe('main')
    expect(normalizeHostedReviewBaseRef('refs/remotes/upstream/release/1.0')).toBe('release/1.0')
  })
})
