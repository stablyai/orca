import { describe, expect, it } from 'vitest'
import type { HostedReviewCreationEligibility } from '../hosted-review/hosted-review-contracts'
import {
  resolveSourceControlCommitAreaPrimaryActionDecision,
  resolveSourceControlDesktopCommitAreaPrimaryActionDecision
} from './source-control-primary-action-decision'
import type { SourceControlPrimaryActionDecisionInputs } from './source-control-primary-action-decision-types'

const CAN_CREATE_PR: HostedReviewCreationEligibility = {
  provider: 'github',
  review: null,
  canCreate: true,
  blockedReason: null,
  nextAction: null,
  reviewLookupOutcome: 'not_found'
}

// Clean tree on a published branch with nothing to push or pull.
function inputs(
  overrides: Partial<SourceControlPrimaryActionDecisionInputs> = {}
): SourceControlPrimaryActionDecisionInputs {
  return {
    stagedCount: 0,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
    hasPartiallyStagedChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
    prState: null,
    hostedReviewCreation: CAN_CREATE_PR,
    ...overrides
  }
}

describe('desktop commit-area primary action', () => {
  it('becomes Create PR once nothing is left to commit, push or pull', () => {
    expect(resolveSourceControlDesktopCommitAreaPrimaryActionDecision(inputs())).toMatchObject({
      kind: 'create_pr',
      disabled: false
    })
  })

  it('keeps the earlier steps ahead of Create PR', () => {
    const push = inputs({ upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 } })
    expect(resolveSourceControlDesktopCommitAreaPrimaryActionDecision(push)).toMatchObject({
      kind: 'push'
    })
    const stage = inputs({ hasUnstagedChanges: true, hasStageableChanges: true })
    expect(resolveSourceControlDesktopCommitAreaPrimaryActionDecision(stage)).toMatchObject({
      kind: 'stage'
    })
  })

  it('stays a disabled Commit when a review cannot be created', () => {
    const blocked = inputs({
      hostedReviewCreation: { ...CAN_CREATE_PR, canCreate: false, blockedReason: 'existing_review' }
    })
    expect(resolveSourceControlDesktopCommitAreaPrimaryActionDecision(blocked)).toMatchObject({
      kind: 'commit',
      disabled: true
    })
  })

  it('drops Sync after an Orca rebase without promoting Force Push', () => {
    const diverged = inputs({
      hostedReviewCreation: null,
      upstreamStatus: { hasUpstream: true, ahead: 3, behind: 2 },
      suppressPullAfterRebase: true
    })
    expect(resolveSourceControlDesktopCommitAreaPrimaryActionDecision(diverged)).toMatchObject({
      kind: 'commit',
      titleIntent: 'nothing_to_commit',
      disabled: true
    })
    const patchEquivalent = inputs({
      upstreamStatus: {
        hasUpstream: true,
        ahead: 3,
        behind: 2,
        behindCommitsArePatchEquivalent: true
      },
      suppressPullAfterRebase: true
    })
    expect(
      resolveSourceControlDesktopCommitAreaPrimaryActionDecision(patchEquivalent)
    ).toMatchObject({ kind: 'push', labelIntent: 'force_push' })
  })

  it('leaves the shared mobile commit-area decision without a Create PR face', () => {
    expect(resolveSourceControlCommitAreaPrimaryActionDecision(inputs())).toMatchObject({
      kind: 'commit',
      disabled: true
    })
  })
})
