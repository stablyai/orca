import { describe, expect, it } from 'vitest'
import {
  buildCreatePrIntentUnavailableEligibility,
  buildLocalBlockerHostedReviewCreationEligibility,
  resolveHostedReviewCreationProviderForTarget
} from './source-control/review/hosted-review-creation-eligibility-snapshot'
import { resolveCreatePrIntentEligibility } from './source-control/review/create-pr-intent-state'

const featureBranch = { branch: 'feature/create-pr', baseRef: 'main' }

describe('resolveHostedReviewCreationProviderForTarget', () => {
  const target = { repoId: 'repo-1', worktreeId: 'worktree-1', branch: 'feature/create-pr' }

  it('does not leak a provider hint across worktrees', () => {
    expect(
      resolveHostedReviewCreationProviderForTarget(
        { ...target, provider: 'gitlab' },
        { ...target, worktreeId: 'worktree-2' },
        'github'
      )
    ).toBe('github')
  })
})

describe('buildLocalBlockerHostedReviewCreationEligibility', () => {
  it('reports dirty with unavailable lookup while still allowing prepare-only Create PR intent', () => {
    const eligibility = buildLocalBlockerHostedReviewCreationEligibility('github', {
      ...featureBranch,
      hasUncommittedChanges: true,
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
    expect(eligibility).toMatchObject({
      blockedReason: 'dirty',
      nextAction: 'commit',
      reviewLookupOutcome: 'unavailable'
    })
    // Why: branch prep is safe without lookup authority; final create stays fail-closed in main.
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

  it('returns null for an ahead-only branch, matching main which will not offer an un-auth-checked push', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('github', {
        ...featureBranch,
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 2,
        behind: 0
      })
    ).toBeNull()
  })

  it('returns null on the default branch even when dirty, so it cannot enable a commit onto the base branch', () => {
    // A failed default-branch probe must not synthesize dirty eligibility that enables committing to the base.
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('github', {
        branch: 'main',
        baseRef: 'origin/main',
        hasUncommittedChanges: true,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).toBeNull()
  })

  it('returns null when the default branch is unknown', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('github', {
        branch: 'main',
        baseRef: null,
        hasUncommittedChanges: true,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).toBeNull()
  })

  it('returns null for a detached HEAD', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('github', {
        branch: 'HEAD',
        baseRef: 'main',
        hasUncommittedChanges: true,
        hasUpstream: false,
        ahead: 0,
        behind: 0
      })
    ).toBeNull()
  })

  it('does not synthesize needs_sync when upstream is unknown but a stale behind count is set', () => {
    // Require confirmed upstream before needs_sync; unknown upstream stays retryable, matching main.
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('github', {
        ...featureBranch,
        hasUncommittedChanges: false,
        hasUpstream: undefined,
        ahead: 0,
        behind: 2
      })
    ).toBeNull()
  })

  it('returns null for providers that do not support hosted review creation', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('unsupported', {
        ...featureBranch,
        hasUncommittedChanges: true,
        hasUpstream: false,
        ahead: 0,
        behind: 0
      })
    ).toBeNull()
  })
})

describe('buildCreatePrIntentUnavailableEligibility', () => {
  it('keeps a rejected click-time probe moving through push and final preflight', () => {
    expect(
      buildCreatePrIntentUnavailableEligibility('github', {
        ...featureBranch,
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 2,
        behind: 0
      })
    ).toMatchObject({
      blockedReason: 'needs_push',
      nextAction: 'push',
      reviewLookupOutcome: 'unavailable'
    })
    expect(
      buildCreatePrIntentUnavailableEligibility('github', {
        ...featureBranch,
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).toMatchObject({
      blockedReason: null,
      nextAction: null,
      reviewLookupOutcome: 'unavailable'
    })
  })
})
