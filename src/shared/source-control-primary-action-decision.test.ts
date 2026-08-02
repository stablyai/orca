import { describe, expect, it } from 'vitest'
import {
  resolveSourceControlCommitAreaPrimaryActionDecision,
  resolveSourceControlPrimaryActionDecision,
  type SourceControlPrimaryActionDecisionInputs
} from './source-control-primary-action-decision'

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
    upstreamStatus: undefined,
    ...overrides
  }
}

describe('source-control primary action decision', () => {
  it('returns Stage All for a dirty tree before remote actions', () => {
    const result = resolveSourceControlCommitAreaPrimaryActionDecision(
      inputs({
        hasUnstagedChanges: true,
        hasStageableChanges: true,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 4 }
      })
    )
    expect(result.kind).toBe('stage')
    expect(result.titleIntent).toBe('stage_all_changes')
    expect(result.disabled).toBe(false)
  })

  it('returns enabled Commit for staged changes with a message', () => {
    const result = resolveSourceControlCommitAreaPrimaryActionDecision(
      inputs({ stagedCount: 2, hasMessage: true })
    )
    expect(result).toMatchObject({
      kind: 'commit',
      titleIntent: 'commit_staged_changes',
      disabled: false
    })
  })

  it('blocks commits while unresolved conflicts exist', () => {
    const result = resolveSourceControlCommitAreaPrimaryActionDecision(
      inputs({ stagedCount: 1, hasMessage: true, hasUnresolvedConflicts: true })
    )
    expect(result).toMatchObject({
      kind: 'commit',
      titleIntent: 'resolve_conflicts_before_commit',
      disabled: true
    })
  })

  it('returns remote push, pull, and sync decisions for clean tracked branches', () => {
    expect(
      resolveSourceControlCommitAreaPrimaryActionDecision(
        inputs({ upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 } })
      )
    ).toMatchObject({ kind: 'push', titleIntent: 'push_count', count: 2 })
    expect(
      resolveSourceControlCommitAreaPrimaryActionDecision(
        inputs({ upstreamStatus: { hasUpstream: true, ahead: 0, behind: 3 } })
      )
    ).toMatchObject({ kind: 'pull', titleIntent: 'pull_count', count: 3 })
    expect(
      resolveSourceControlCommitAreaPrimaryActionDecision(
        inputs({ upstreamStatus: { hasUpstream: true, ahead: 2, behind: 3 } })
      )
    ).toMatchObject({ kind: 'sync', titleIntent: 'sync_counts', ahead: 2, behind: 3 })
  })

  it('returns Publish Branch for clean unpublished branches with a current branch', () => {
    const result = resolveSourceControlCommitAreaPrimaryActionDecision(
      inputs({
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        hasCurrentBranch: true
      })
    )
    expect(result).toMatchObject({
      kind: 'publish',
      titleIntent: 'publish_branch',
      disabled: false
    })
  })

  it('blocks unpublished branch publishing when HEAD is detached', () => {
    const result = resolveSourceControlCommitAreaPrimaryActionDecision(
      inputs({
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        hasCurrentBranch: false
      })
    )
    expect(result).toMatchObject({
      kind: 'commit',
      titleIntent: 'checkout_branch_before_publish',
      disabled: true
    })
  })

  it('mirrors in-flight remote operation semantics', () => {
    const result = resolveSourceControlCommitAreaPrimaryActionDecision(
      inputs({
        isRemoteOperationActive: true,
        inFlightRemoteOpKind: 'pull',
        upstreamStatus: { hasUpstream: true, ahead: 3, behind: 0 }
      })
    )
    expect(result).toMatchObject({
      kind: 'pull',
      labelIntent: 'pull',
      titleIntent: 'action_in_progress',
      disabled: true
    })
  })

  it('marks patch-equivalent diverged branches as force-push-with-lease decisions', () => {
    const result = resolveSourceControlCommitAreaPrimaryActionDecision(
      inputs({
        branchCommitsAhead: 4,
        upstreamStatus: {
          hasUpstream: true,
          upstreamName: 'origin/feature',
          ahead: 14,
          behind: 3,
          behindCommitsArePatchEquivalent: true
        }
      })
    )
    expect(result).toMatchObject({
      kind: 'push',
      labelIntent: 'force_push',
      titleIntent: 'force_push_with_lease',
      requiresForceWithLease: true,
      count: 4,
      upstreamName: 'origin/feature'
    })
  })

  it('keeps review creation out of commit-area decisions', () => {
    const input = inputs({
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
      hostedReviewCreation: {
        provider: 'gitlab',
        review: null,
        canCreate: true,
        blockedReason: null,
        nextAction: null,
        reviewLookupOutcome: 'not_found'
      }
    })
    expect(resolveSourceControlPrimaryActionDecision(input).kind).toBe('create_pr')
    expect(resolveSourceControlCommitAreaPrimaryActionDecision(input).kind).toBe('commit')
  })

  it('returns disabled create review while hosted-review creation eligibility is loading', () => {
    const result = resolveSourceControlPrimaryActionDecision(
      inputs({
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        hostedReviewCreation: {
          provider: 'gitlab',
          review: null,
          canCreate: false,
          blockedReason: null,
          nextAction: null,
          reviewLookupOutcome: 'not_found'
        },
        isHostedReviewCreationLoading: true
      })
    )
    expect(result).toMatchObject({
      kind: 'create_pr',
      titleIntent: 'checking_review_creation',
      disabled: true
    })
  })
})
