import { expect, it } from 'vitest'
import { normalizeHostedReviewBaseRef } from './hosted-review-refs'

it('preserves branch prefixes after removing one explicit ref namespace', () => {
  expect(normalizeHostedReviewBaseRef('refs/heads/origin/topic')).toBe('origin/topic')
  expect(normalizeHostedReviewBaseRef('refs/remotes/origin/origin/topic')).toBe('origin/topic')
  expect(normalizeHostedReviewBaseRef('refs/heads/upstream/topic')).toBe('upstream/topic')
  expect(normalizeHostedReviewBaseRef('refs/heads/refs/remotes/origin/topic')).toBe(
    'refs/remotes/origin/topic'
  )
  expect(normalizeHostedReviewBaseRef('origin/main')).toBe('main')
  expect(normalizeHostedReviewBaseRef('upstream/main')).toBe('main')
  expect(normalizeHostedReviewBaseRef('refs/remotes/origin/main')).toBe('main')
  expect(normalizeHostedReviewBaseRef(' refs/heads/feature/topic ')).toBe('feature/topic')
})
