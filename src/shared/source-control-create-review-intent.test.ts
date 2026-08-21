import { describe, expect, it } from 'vitest'
import {
  resolveCreateReviewIntentEligibility,
  type CreateReviewIntentKind
} from './source-control-create-review-intent'
import type { HostedReviewCreationBlockedReason } from './hosted-review'
import type { GitUpstreamStatus } from './git-status-types'

function unavailableEligibility(blockedReason: HostedReviewCreationBlockedReason) {
  return {
    provider: 'github' as const,
    review: null,
    canCreate: false,
    blockedReason,
    nextAction: null,
    defaultBaseRef: 'main',
    reviewLookupOutcome: 'unavailable' as const
  }
}

describe('resolveCreateReviewIntentEligibility', () => {
  it('rejects unavailable eligibility when the default branch is unknown', () => {
    expect(
      resolveCreateReviewIntentEligibility({
        stagedCount: 1,
        hasStageableChanges: true,
        hasMessage: true,
        hasUnresolvedConflicts: false,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        hostedReviewCreation: {
          ...unavailableEligibility('dirty'),
          defaultBaseRef: null
        }
      })
    ).toEqual({ eligible: false, kind: null })
  })

  it('rejects unavailable eligibility when the default branch is blank', () => {
    expect(
      resolveCreateReviewIntentEligibility({
        stagedCount: 1,
        hasStageableChanges: true,
        hasMessage: true,
        hasUnresolvedConflicts: false,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        hostedReviewCreation: {
          ...unavailableEligibility('dirty'),
          defaultBaseRef: '   '
        }
      })
    ).toEqual({ eligible: false, kind: null })
  })

  it('stays ineligible when no local blocker remains under unavailable lookup', () => {
    expect(
      resolveCreateReviewIntentEligibility({
        stagedCount: 0,
        hasStageableChanges: false,
        hasMessage: true,
        hasUnresolvedConflicts: false,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        hostedReviewCreation: {
          ...unavailableEligibility('dirty'),
          blockedReason: null
        }
      })
    ).toEqual({ eligible: false, kind: null })
  })

  it('keeps dirty local preparation eligible when review lookup is unavailable', () => {
    expect(
      resolveCreateReviewIntentEligibility({
        stagedCount: 0,
        hasStageableChanges: true,
        hasMessage: true,
        hasUnresolvedConflicts: false,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        hostedReviewCreation: unavailableEligibility('dirty')
      })
    ).toEqual({ eligible: true, kind: 'dirty' })
  })

  it('still requires a message before committing staged changes without lookup authority', () => {
    expect(
      resolveCreateReviewIntentEligibility({
        stagedCount: 1,
        hasStageableChanges: false,
        hasMessage: false,
        hasUnresolvedConflicts: false,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        hostedReviewCreation: unavailableEligibility('dirty')
      })
    ).toEqual({ eligible: true, kind: 'message_required' })
  })

  it.each<{
    blockedReason: HostedReviewCreationBlockedReason
    blockedKind: CreateReviewIntentKind
    stagedCount?: number
    hasStageableChanges?: boolean
    branchCommitsAhead?: number
    upstreamStatus?: GitUpstreamStatus
  }>([
    {
      blockedReason: 'no_upstream',
      blockedKind: 'no_upstream',
      branchCommitsAhead: 1,
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
    },
    {
      blockedReason: 'needs_push',
      blockedKind: 'needs_push',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 1,
        behind: 0
      }
    },
    {
      blockedReason: 'needs_sync',
      blockedKind: 'needs_sync',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 0,
        behind: 1
      }
    },
    {
      blockedReason: 'needs_sync',
      blockedKind: 'force_push',
      branchCommitsAhead: 1,
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 2,
        behind: 1,
        behindCommitsArePatchEquivalent: true
      }
    }
  ])(
    'keeps recoverable $blockedKind preparation eligible when review lookup is unavailable',
    ({
      blockedReason,
      blockedKind,
      stagedCount = 0,
      hasStageableChanges = false,
      branchCommitsAhead,
      upstreamStatus
    }) => {
      expect(
        resolveCreateReviewIntentEligibility({
          stagedCount,
          hasStageableChanges,
          hasMessage: true,
          hasUnresolvedConflicts: false,
          upstreamStatus,
          hostedReviewCreation: unavailableEligibility(blockedReason),
          branchCommitsAhead
        })
      ).toEqual({ eligible: true, kind: blockedKind })
    }
  )
})
