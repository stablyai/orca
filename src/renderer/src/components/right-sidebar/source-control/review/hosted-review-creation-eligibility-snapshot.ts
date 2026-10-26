import { supportsHostedReviewCreation } from '../../../../../../shared/hosted-review-creation-providers'
import { normalizeHostedReviewBaseRef } from '../../../../../../shared/hosted-review-refs'
import type {
  HostedReviewCreationEligibility,
  HostedReviewProvider
} from '../../../../../../shared/hosted-review'

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
    // Loading placeholders cannot establish whether a review exists.
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

/** After remote failure, offer local blockers in dirty/no-upstream/needs-sync order, never permission to create; require a known non-default branch and return null for unknown upstream or no blocker. */
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
    // Local Git blockers cannot establish whether a hosted review exists.
    reviewLookupOutcome: 'unavailable' as const
  }
  if (status.hasUncommittedChanges) {
    return { ...base, blockedReason: 'dirty', nextAction: 'commit' }
  }
  if (status.hasUpstream === false) {
    return { ...base, blockedReason: 'no_upstream', nextAction: 'publish' }
  }
  // Unknown upstream remains retryable, matching main.
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
