import { describe, expect, it } from 'vitest'
import type { HostedReviewQueueSummary } from './hosted-review'
import {
  classifyHostedReview,
  hostedReviewIdentityKey,
  reviewNeedsResponse,
  reviewReadyToMerge
} from './hosted-review-queue'

function baseSummary(overrides: Partial<HostedReviewQueueSummary> = {}): HostedReviewQueueSummary {
  return {
    identity: { provider: 'github', host: 'github.com', owner: 'acme', repo: 'orca', number: 42 },
    title: 'Improve checks panel',
    url: 'https://github.com/acme/orca/pull/42',
    state: 'open',
    author: { login: 'teammate' },
    updatedAt: '2026-05-10T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    checksStatus: 'success',
    threadSummary: { unresolvedCount: 0 },
    ...overrides
  }
}

describe('hostedReviewIdentityKey', () => {
  it('includes provider and host for enterprise-safe keys', () => {
    const dotcom = hostedReviewIdentityKey({
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'orca',
      number: 7
    })
    const ghe = hostedReviewIdentityKey({
      provider: 'github',
      host: 'github.acme.internal',
      owner: 'acme',
      repo: 'orca',
      number: 7
    })
    expect(dotcom).not.toBe(ghe)
  })
})

describe('classifyHostedReview', () => {
  it('classifies mine/requested/agent/teammate', () => {
    expect(
      classifyHostedReview(baseSummary({ author: { login: 'me' } }), {
        viewer: { login: 'me' }
      }).state
    ).toBe('mine')

    expect(
      classifyHostedReview(baseSummary({ requestedReviewerLogins: ['me'] }), {
        viewer: { login: 'me' }
      }).state
    ).toBe('requested')

    expect(
      classifyHostedReview(baseSummary({ author: { login: 'orca-ci' } }), {
        agentAuthorLogins: ['orca-ci']
      }).state
    ).toBe('agent')

    expect(classifyHostedReview(baseSummary()).state).toBe('teammate')
  })
})

describe('reviewNeedsResponse', () => {
  it('returns true for unresolved threads, failed checks, conflicts, and newer remote updates', () => {
    expect(reviewNeedsResponse(baseSummary({ threadSummary: { unresolvedCount: 1 } }))).toBe(true)
    expect(reviewNeedsResponse(baseSummary({ checksStatus: 'failure' }))).toBe(true)
    expect(reviewNeedsResponse(baseSummary({ mergeable: 'CONFLICTING' }))).toBe(true)
    expect(
      reviewNeedsResponse(
        baseSummary({
          updatedAt: '2026-05-11T00:00:00.000Z',
          lastViewedAt: Date.parse('2026-05-10T00:00:00.000Z')
        })
      )
    ).toBe(true)
  })

  it('does not mark needs-response from updatedAt alone when lastViewedAt is missing', () => {
    expect(reviewNeedsResponse(baseSummary({ updatedAt: '2026-05-11T00:00:00.000Z' }))).toBe(false)
  })
})

describe('reviewReadyToMerge', () => {
  it('rejects drafts, conflicts, failed/pending checks, unresolved threads, and unknown mergeability', () => {
    expect(reviewReadyToMerge(baseSummary({ state: 'draft', draft: true }))).toBe(false)
    expect(reviewReadyToMerge(baseSummary({ mergeable: 'CONFLICTING' }))).toBe(false)
    expect(reviewReadyToMerge(baseSummary({ checksStatus: 'failure' }))).toBe(false)
    expect(reviewReadyToMerge(baseSummary({ checksStatus: 'pending' }))).toBe(false)
    expect(reviewReadyToMerge(baseSummary({ threadSummary: { unresolvedCount: 2 } }))).toBe(false)
    expect(reviewReadyToMerge(baseSummary({ threadSummary: undefined }))).toBe(false)
    expect(reviewReadyToMerge(baseSummary({ mergeable: 'UNKNOWN' }))).toBe(false)
  })

  it('accepts neutral checks when all other gates pass', () => {
    expect(reviewReadyToMerge(baseSummary({ checksStatus: 'neutral' }))).toBe(true)
  })
})
