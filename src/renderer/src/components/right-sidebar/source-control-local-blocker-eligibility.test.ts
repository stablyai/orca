import { describe, expect, it } from 'vitest'
import { buildLocalBlockerHostedReviewCreationEligibility } from './source-control-hosted-review-creation-eligibility-snapshot'
import { resolveCreatePrIntentEligibility } from './source-control-create-pr-intent-state'

describe('buildLocalBlockerHostedReviewCreationEligibility', () => {
  it('reports dirty when there are uncommitted changes', () => {
    const eligibility = buildLocalBlockerHostedReviewCreationEligibility('github', {
      hasUncommittedChanges: true,
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
    expect(eligibility).toMatchObject({ blockedReason: 'dirty', nextAction: 'commit' })
    // The synthesized blocker must drive the actionable Create PR intent so a
    // failed remote probe still offers commit/publish preparation.
    expect(
      resolveCreatePrIntentEligibility({
        stagedCount: 1,
        hasStageableChanges: true,
        hasMessage: true,
        hasUnresolvedConflicts: false,
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        hostedReviewCreation: eligibility,
        branchCommitsAhead: 0
      })
    ).toEqual({ eligible: true, kind: 'dirty' })
  })

  it('prefers dirty over no_upstream when both apply, matching main-process ordering', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('gitlab', {
        hasUncommittedChanges: true,
        hasUpstream: false,
        ahead: 0,
        behind: 0
      })
    ).toMatchObject({ provider: 'gitlab', blockedReason: 'dirty' })
  })

  it('reports no_upstream for a clean unpublished branch', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('github', {
        hasUncommittedChanges: false,
        hasUpstream: false,
        ahead: 0,
        behind: 0
      })
    ).toMatchObject({ blockedReason: 'no_upstream', nextAction: 'publish' })
  })

  it('reports needs_sync when the branch is behind its upstream', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('github', {
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 1,
        behind: 3
      })
    ).toMatchObject({ blockedReason: 'needs_sync', nextAction: 'sync' })
  })

  it('reports needs_push when the branch is ahead of an up-to-date upstream', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('github', {
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 2,
        behind: 0
      })
    ).toMatchObject({ blockedReason: 'needs_push', nextAction: 'push' })
  })

  it('returns null when the local status cannot determine a blocker', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('github', {
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).toBeNull()
  })

  it('returns null for providers that do not support hosted review creation', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('bitbucket', {
        hasUncommittedChanges: true,
        hasUpstream: false,
        ahead: 0,
        behind: 0
      })
    ).toBeNull()
  })
})
