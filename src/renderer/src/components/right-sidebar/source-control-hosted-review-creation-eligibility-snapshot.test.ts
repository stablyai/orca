import { describe, expect, it } from 'vitest'
import {
  buildLocalBlockerHostedReviewCreationEligibility,
  resolveHostedReviewCreationProviderForTarget
} from './source-control-hosted-review-creation-eligibility-snapshot'
import { resolveCreatePrIntentEligibility } from './source-control-create-pr-intent-state'

const featureBranch = { branch: 'feature/create-pr', baseRef: 'main' }

describe('resolveHostedReviewCreationProviderForTarget', () => {
  const target = { repoId: 'repo-1', worktreeId: 'worktree-1', branch: 'feature/create-pr' }

  it('preserves a known self-hosted provider for the same target', () => {
    expect(
      resolveHostedReviewCreationProviderForTarget(
        { ...target, provider: 'gitlab' },
        target,
        'github'
      )
    ).toBe('gitlab')
  })

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
  it('reports dirty without offering create intent when the review lookup failed', () => {
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
    // Why: branch guidance can remain specific, but a failed lookup cannot authorize creation.
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
    ).toEqual({ eligible: false, kind: null })
  })

  it('prefers dirty over no_upstream when both apply, matching main-process ordering', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('gitlab', {
        ...featureBranch,
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
        ...featureBranch,
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
        ...featureBranch,
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 1,
        behind: 3
      })
    ).toMatchObject({ blockedReason: 'needs_sync', nextAction: 'sync' })
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
    // Guards the regression where a failed probe on the default branch
    // synthesized dirty/commit and surfaced an enabled Create PR.
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

  it('returns null when the local status cannot determine a blocker', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('github', {
        ...featureBranch,
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).toBeNull()
  })

  it('returns null when upstream status is unknown, matching main which treats it as retryable', () => {
    expect(
      buildLocalBlockerHostedReviewCreationEligibility('github', {
        ...featureBranch,
        hasUncommittedChanges: false,
        hasUpstream: undefined,
        ahead: undefined,
        behind: undefined
      })
    ).toBeNull()
  })

  it('does not synthesize needs_sync when upstream is unknown but a stale behind count is set', () => {
    // The needs_sync branch is gated on hasUpstream === true so an unknown
    // upstream stays retryable, matching main's `hasUpstream !== true` → null.
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
      buildLocalBlockerHostedReviewCreationEligibility('bitbucket', {
        ...featureBranch,
        hasUncommittedChanges: true,
        hasUpstream: false,
        ahead: 0,
        behind: 0
      })
    ).toBeNull()
  })
})
