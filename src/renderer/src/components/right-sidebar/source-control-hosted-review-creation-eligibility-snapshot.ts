import { supportsHostedReviewCreation } from '../../../../shared/hosted-review-creation-providers'
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
    nextAction: null
  }
}

/**
 * Local-status-only eligibility used when the remote creation probe fails or
 * times out. Mirrors the main-process local-blocker ordering (dirty →
 * no_upstream → needs_sync → needs_push) so a failed probe still offers the
 * actionable commit/publish/push/sync preparation action instead of leaving an
 * inert disabled button. Returns null when the local status cannot determine a
 * blocker (e.g. a fully-synced branch), so the caller can surface a retry.
 */
export function buildLocalBlockerHostedReviewCreationEligibility(
  provider: HostedReviewProvider,
  status: {
    hasUncommittedChanges: boolean
    hasUpstream: boolean | undefined
    ahead: number | undefined
    behind: number | undefined
  }
): HostedReviewCreationEligibility | null {
  if (!supportsHostedReviewCreation(provider)) {
    return null
  }
  const base = {
    provider,
    review: null,
    canCreate: false as const,
    defaultBaseRef: null,
    head: null
  }
  if (status.hasUncommittedChanges) {
    return { ...base, blockedReason: 'dirty', nextAction: 'commit' }
  }
  if (status.hasUpstream === false) {
    return { ...base, blockedReason: 'no_upstream', nextAction: 'publish' }
  }
  if ((status.behind ?? 0) > 0) {
    return { ...base, blockedReason: 'needs_sync', nextAction: 'sync' }
  }
  if (status.hasUpstream === true && (status.ahead ?? 0) > 0) {
    return { ...base, blockedReason: 'needs_push', nextAction: 'push' }
  }
  return null
}
