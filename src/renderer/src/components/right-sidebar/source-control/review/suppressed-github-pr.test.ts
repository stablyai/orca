import { describe, expect, it } from 'vitest'
import type {
  HostedReviewCreationEligibility,
  HostedReviewInfo
} from '../../../../../../shared/hosted-review'
import { resolveSourceControlSuppressedGitHubPRState } from './suppressed-github-pr'

const worktree = {
  linkedPR: null,
  linkedGitLabMR: null,
  linkedBitbucketPR: null,
  linkedAzureDevOpsPR: null,
  linkedGiteaPR: null,
  suppressedGitHubPR: 42
}

const notFound: HostedReviewCreationEligibility = {
  provider: 'github',
  review: null,
  canCreate: true,
  blockedReason: null,
  nextAction: null,
  reviewLookupOutcome: 'not_found'
}

const differentReview: HostedReviewInfo = {
  provider: 'github',
  number: 43,
  title: 'Different PR',
  state: 'open',
  url: 'https://github.com/acme/orca/pull/43',
  status: 'pending',
  updatedAt: '2026-08-28T00:00:00Z',
  mergeable: 'UNKNOWN'
}

const unavailable: HostedReviewCreationEligibility = {
  ...notFound,
  canCreate: false,
  blockedReason: 'no_upstream',
  reviewLookupOutcome: 'unavailable'
}

function resolve(
  overrides: Partial<Parameters<typeof resolveSourceControlSuppressedGitHubPRState>[0]> = {}
) {
  return resolveSourceControlSuppressedGitHubPRState({
    worktree,
    isFolder: false,
    provider: 'github',
    hasMatchingSuppressedPR: false,
    hostedReview: null,
    hostedReviewCreation: null,
    isHostedReviewCreationLoading: false,
    hostedReviewCreationRequestFailed: false,
    ...overrides
  })
}

describe('resolveSourceControlSuppressedGitHubPRState', () => {
  it('shows recovery only after cache or eligibility evidence matches the tombstone', () => {
    expect(resolve({ hasMatchingSuppressedPR: true })).toEqual({ number: 42, status: 'matched' })
    expect(
      resolve({
        hostedReviewCreation: {
          ...notFound,
          review: { number: 42, url: 'https://github.com/acme/orca/pull/42' },
          canCreate: false,
          blockedReason: 'existing_review',
          nextAction: 'open_existing_review',
          reviewLookupOutcome: 'found'
        }
      })
    ).toEqual({ number: 42, status: 'matched' })
  })

  it('suppresses transient Create PR chrome only while the marker is unresolved', () => {
    expect(resolve()).toEqual({ number: 42, status: 'pending' })
    expect(
      resolve({ hostedReviewCreation: notFound, isHostedReviewCreationLoading: true })
    ).toEqual({ number: 42, status: 'pending' })
  })

  it('returns to normal chrome after stale, different, unavailable, or failed evidence', () => {
    expect(resolve({ hostedReviewCreation: notFound })).toBeNull()
    expect(resolve({ hostedReview: differentReview })).toBeNull()
    expect(resolve({ hostedReviewCreation: unavailable })).toBeNull()
    expect(resolve({ hostedReviewCreationRequestFailed: true })).toBeNull()
    expect(
      resolve({
        hostedReviewCreation: {
          ...notFound,
          review: { number: 43, url: differentReview.url },
          canCreate: false,
          blockedReason: 'existing_review',
          nextAction: 'open_existing_review',
          reviewLookupOutcome: 'found'
        }
      })
    ).toBeNull()
  })

  it('does not apply GitHub recovery to folders, other providers, or invalid markers', () => {
    expect(resolve({ isFolder: true })).toBeNull()
    expect(resolve({ provider: 'gitlab' })).toBeNull()
    expect(resolve({ worktree: { ...worktree, suppressedGitHubPR: null } })).toBeNull()
  })

  it.each([
    ['GitHub', { linkedPR: 42 }],
    ['GitLab', { linkedGitLabMR: 9 }],
    ['Bitbucket', { linkedBitbucketPR: 9 }],
    ['Azure DevOps', { linkedAzureDevOpsPR: 9 }],
    ['Gitea', { linkedGiteaPR: 9 }]
  ])('keeps an explicit %s review ahead of stale GitHub suppression', (_provider, link) => {
    expect(resolve({ worktree: { ...worktree, ...link } })).toBeNull()
  })
})
