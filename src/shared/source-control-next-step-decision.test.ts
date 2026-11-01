import { describe, expect, it } from 'vitest'
import type { PRInfo } from './github/pull-request-types'
import { resolveSourceControlCommitAreaPrimaryActionDecision } from './source-control-primary-action-decision'
import type { SourceControlPrimaryActionDecisionInputs } from './source-control-primary-action-decision-types'
import {
  resolveSourceControlNextStep,
  type SourceControlNextStepInputs
} from './source-control-next-step-decision'

function local(overrides: Partial<SourceControlPrimaryActionDecisionInputs> = {}) {
  return resolveSourceControlCommitAreaPrimaryActionDecision({
    stagedCount: 0,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
    hasPartiallyStagedChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
    ...overrides
  })
}

const OPEN_PR: PRInfo = {
  number: 7,
  title: 'feat',
  state: 'open',
  url: 'https://github.com/o/r/pull/7',
  checksStatus: 'success',
  updatedAt: '2026-11-01T00:00:00Z',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED'
}

function step(overrides: Partial<SourceControlNextStepInputs> = {}, pr: Partial<PRInfo> = {}) {
  return resolveSourceControlNextStep({
    local: local(),
    conflictOperation: null,
    hasUnresolvedConflicts: false,
    hasChangesToCommit: false,
    reviewCreation: 'unavailable',
    review: { kind: 'github', pr: { ...OPEN_PR, ...pr }, failedChecks: 0, pendingChecks: 0 },
    ...overrides
  })
}

describe('resolveSourceControlNextStep', () => {
  it('walks the branch from local work to merge in order', () => {
    expect(step({ hasUnresolvedConflicts: true, conflictOperation: 'merge' })).toEqual({
      kind: 'resolve_conflicts',
      scope: 'local'
    })
    expect(step({ conflictOperation: 'merge' }).kind).toBe('complete_merge')
    expect(
      step({
        hasChangesToCommit: true,
        local: local({ hasStageableChanges: true, hasUnstagedChanges: true })
      }).kind
    ).toBe('commit')
    expect(step({ hasChangesToCommit: true, local: local({ stagedCount: 2 }) }).kind).toBe('commit')
    // A fetch on a clean branch blocks commits but leaves nothing to commit.
    expect(
      step({ local: local({ isRemoteOperationActive: true, inFlightRemoteOpKind: 'fetch' }) }).kind
    ).toBe('merge')
    expect(
      step({ local: local({ upstreamStatus: { hasUpstream: true, ahead: 3, behind: 0 } }) }).kind
    ).toBe('remote')
    expect(
      step(
        {},
        { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'REVIEW_REQUIRED' }
      )
    ).toEqual({ kind: 'resolve_conflicts', scope: 'review' })
    expect(
      step({ review: { kind: 'github', pr: OPEN_PR, failedChecks: 1, pendingChecks: 0 } })
    ).toEqual({ kind: 'fix_checks', failedChecks: 1 })
    expect(step({}, { autoMergeEnabled: true }).kind).toBe('auto_merge_on')
    expect(step().kind).toBe('merge')
    expect(step({}, { state: 'merged' }).kind).toBe('merged')
  })

  it('offers Create PR only once nothing local is left, pushing first when the host asks', () => {
    expect(step({ review: { kind: 'none' }, reviewCreation: 'create' })).toEqual({
      kind: 'create_review',
      pushFirst: false
    })
    expect(
      step({
        local: local({ upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 } }),
        review: { kind: 'none' },
        reviewCreation: 'push_and_create'
      })
    ).toEqual({ kind: 'create_review', pushFirst: true })
    expect(
      step({
        local: local({ stagedCount: 1, hasMessage: true }),
        hasChangesToCommit: true,
        review: { kind: 'none' },
        reviewCreation: 'create'
      }).kind
    ).toBe('commit')
    expect(step({ review: { kind: 'none' } }).kind).toBe('none')
    expect(step({ review: { kind: 'loading' }, reviewCreation: 'create' }).kind).toBe('none')
  })

  it('turns on auto-merge while GitHub waits on a requirement, and says why when nothing can', () => {
    expect(
      step({
        review: {
          kind: 'github',
          pr: { ...OPEN_PR, mergeStateStatus: 'BLOCKED' },
          failedChecks: 0,
          pendingChecks: 2
        }
      })
    ).toEqual({ kind: 'merge_when_ready', mergeState: 'blocked', pendingChecks: 2 })
    expect(step({}, { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' })).toEqual({
      kind: 'merge_when_ready',
      mergeState: 'review_required',
      pendingChecks: 0
    })
    expect(step({}, { mergeStateStatus: 'BLOCKED', autoMergeAllowed: false })).toEqual({
      kind: 'merge_blocked',
      mergeState: 'blocked'
    })
    expect(step({}, { state: 'draft' })).toEqual({ kind: 'merge_blocked', mergeState: 'draft' })
  })
})
