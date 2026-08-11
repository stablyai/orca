import { supportsHostedReviewCreation } from '../../../../shared/hosted-review-creation-providers'
import { normalizeHostedReviewBaseRef } from '../../../../shared/hosted-review-refs'
import type {
  HostedReviewCreationEligibility,
  HostedReviewProvider
} from '../../../../shared/hosted-review'

type UnavailableHostedReviewStatus = {
  branch: string | null | undefined
  baseRef: string | null | undefined
  hasUncommittedChanges: boolean
  hasUpstream: boolean | undefined
  ahead: number | undefined
  behind: number | undefined
}

function resolveUnavailableHostedReviewBranch(
  provider: HostedReviewProvider,
  status: UnavailableHostedReviewStatus
): string | null {
  const branch = status.branch?.trim() ?? ''
  const baseBranch = normalizeHostedReviewBaseRef(status.baseRef ?? '').trim()
  if (
    branch === '' ||
    branch === 'HEAD' ||
    baseBranch === '' ||
    !supportsHostedReviewCreation(provider) ||
    branch.toLowerCase() === baseBranch.toLowerCase()
  ) {
    return null
  }
  return branch
}

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
 * Blocker ordering matches main (`dirty` → `no_upstream` → `needs_sync`). The
 * branch/base guard is load-bearing and intentionally stricter than main when
 * base is unknown: without a known base, a failed probe must not synthesize
 * `dirty`/`commit` on what might be the default branch (main would return
 * `default_branch`/`detached_head` and keep Create disabled). Returns null
 * when no local blocker is determinable (unknown base, unknown upstream,
 * ahead-only, fully synced) so the caller can surface the retryable state —
 * matching main, which won't offer a push it can't first auth-check.
 */
export function buildLocalBlockerHostedReviewCreationEligibility(
  provider: HostedReviewProvider,
  status: UnavailableHostedReviewStatus
): HostedReviewCreationEligibility | null {
  const branch = resolveUnavailableHostedReviewBranch(provider, status)
  if (
    !branch ||
    (!status.hasUncommittedChanges && status.hasUpstream === true && (status.behind ?? 0) === 0)
  ) {
    return null
  }
  const base = {
    provider,
    review: null,
    canCreate: false as const,
    defaultBaseRef: normalizeHostedReviewBaseRef(status.baseRef ?? '').trim(),
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

export function buildCreatePrIntentUnavailableEligibility(
  provider: HostedReviewProvider,
  status: UnavailableHostedReviewStatus
): HostedReviewCreationEligibility | null {
  const localBlocker = buildLocalBlockerHostedReviewCreationEligibility(provider, status)
  if (localBlocker) {
    return localBlocker
  }
  const branch = resolveUnavailableHostedReviewBranch(provider, status)
  if (!branch || status.hasUpstream !== true) {
    return null
  }
  const base = {
    provider,
    review: null,
    canCreate: false as const,
    defaultBaseRef: normalizeHostedReviewBaseRef(status.baseRef ?? '').trim(),
    head: branch,
    reviewLookupOutcome: 'unavailable' as const
  }
  if ((status.ahead ?? 0) > 0) {
    return { ...base, blockedReason: 'needs_push', nextAction: 'push' }
  }
  return { ...base, blockedReason: null, nextAction: null }
}
