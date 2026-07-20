import { supportsHostedReviewCreation } from '../../../../shared/hosted-review-creation-providers'
import { normalizeHostedReviewBaseRef } from '../../../../shared/hosted-review-refs'
import type {
  HostedReviewCreationEligibility,
  HostedReviewProvider
} from '../../../../shared/hosted-review'

export function buildLoadingHostedReviewCreationEligibility(
  provider: HostedReviewProvider
): HostedReviewCreationEligibility {
  return {
    provider,
    review: null,
    canCreate: false,
    blockedReason: null,
    nextAction: null,
    // Why: a loading placeholder has no authoritative existing-review result.
    reviewLookupOutcome: 'unavailable'
  }
}

export function resolveHostedReviewCreationProviderForTarget(
  hint: {
    repoId: string | null
    worktreeId: string | null
    branch: string
    provider: HostedReviewProvider
  },
  target: { repoId: string | null; worktreeId: string | null; branch: string },
  fallback: HostedReviewProvider
): HostedReviewProvider {
  return hint.repoId === target.repoId &&
    hint.worktreeId === target.worktreeId &&
    hint.branch === target.branch
    ? hint.provider
    : fallback
}

/**
 * Local-status-only eligibility used when the remote creation probe fails or
 * times out, so the UI can show branch guidance without treating the failed
 * lookup as authority to create a review.
 *
 * Mirrors the main process's own lookup-failure fallback exactly — both its
 * `canReturnLocalBlocker` guard and its blocker ordering
 * (`src/main/source-control/hosted-review-creation.ts`). The guard is
 * load-bearing: without it a failed probe on the default branch or a detached
 * HEAD would synthesize `dirty`/`commit` and surface an *enabled* Create PR
 * that commits onto the base branch, where the real probe returns
 * `default_branch`/`detached_head` (disabled). Returns null when no local
 * blocker is determinable (unknown upstream, ahead-only, fully synced) so the
 * caller can surface the retryable state — matching main, which won't offer a
 * push it can't first auth-check.
 */
export function buildLocalBlockerHostedReviewCreationEligibility(
  provider: HostedReviewProvider,
  status: {
    branch: string | null | undefined
    baseRef: string | null | undefined
    hasUncommittedChanges: boolean
    hasUpstream: boolean | undefined
    ahead: number | undefined
    behind: number | undefined
  }
): HostedReviewCreationEligibility | null {
  const branch = status.branch?.trim() ?? ''
  const baseBranch = normalizeHostedReviewBaseRef(status.baseRef ?? '').trim()
  const canReturnLocalBlocker =
    branch !== '' &&
    branch !== 'HEAD' &&
    supportsHostedReviewCreation(provider) &&
    (baseBranch === '' || branch.toLowerCase() !== baseBranch.toLowerCase()) &&
    (status.hasUncommittedChanges || status.hasUpstream !== true || (status.behind ?? 0) > 0)
  if (!canReturnLocalBlocker) {
    return null
  }
  const base = {
    provider,
    review: null,
    canCreate: false as const,
    defaultBaseRef: null,
    head: branch,
    // Why: local Git blockers cannot prove that a hosted review does not exist.
    reviewLookupOutcome: 'unavailable' as const
  }
  if (status.hasUncommittedChanges) {
    return { ...base, blockedReason: 'dirty', nextAction: 'commit' }
  }
  if (status.hasUpstream === false) {
    return { ...base, blockedReason: 'no_upstream', nextAction: 'publish' }
  }
  // Unknown upstream (hasUpstream !== true) is retryable, not an actionable
  // blocker — mirror main, which returns a null blocker there.
  if (status.hasUpstream === true && (status.behind ?? 0) > 0) {
    return { ...base, blockedReason: 'needs_sync', nextAction: 'sync' }
  }
  return null
}
