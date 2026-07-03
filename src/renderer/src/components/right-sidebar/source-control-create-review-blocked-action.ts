import type {
  HostedReviewCreationBlockedReason,
  HostedReviewCreationEligibility,
  HostedReviewProvider
} from '../../../../shared/hosted-review'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'

export function canClickBlockedCreateReviewReason(
  reason: HostedReviewCreationBlockedReason | undefined
): boolean {
  // Why: actionable blocked states stay clickable so the UI can explain the
  // next step inline instead of silently hard-disabling Create Review.
  return (
    reason === 'dirty' ||
    reason === 'default_branch' ||
    reason === 'no_upstream' ||
    reason === 'needs_push' ||
    reason === 'needs_sync' ||
    reason === 'auth_required'
  )
}

export function resolveHostedReviewAuthInstruction(provider: HostedReviewProvider): string {
  if (provider === 'gitlab') {
    return 'Run glab auth login'
  }
  if (provider === 'azure-devops') {
    return 'Set ORCA_AZURE_DEVOPS_TOKEN'
  }
  if (provider === 'gitea') {
    return 'Set ORCA_GITEA_TOKEN'
  }
  return 'Run gh auth login'
}

export function resolveBlockedCreateReviewNoticeMessage(
  eligibility: HostedReviewCreationEligibility | null | undefined
): string | null {
  if (!eligibility || eligibility.canCreate) {
    return null
  }
  const reason = eligibility.blockedReason
  if (!canClickBlockedCreateReviewReason(reason)) {
    return null
  }
  const copy = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(eligibility.provider)
  )
  switch (reason) {
    case 'dirty':
      return `Create ${copy.shortLabel} failed: commit or discard local changes before creating a ${copy.reviewLabel}.`
    case 'default_branch':
      return `Create ${copy.shortLabel} failed: choose a feature branch before creating a ${copy.reviewLabel}.`
    case 'no_upstream':
      return `Create ${copy.shortLabel} failed: publish this branch before creating a ${copy.reviewLabel}.`
    case 'needs_push':
      return `Create ${copy.shortLabel} failed: push this branch before creating a ${copy.reviewLabel}.`
    case 'needs_sync':
      return `Create ${copy.shortLabel} failed: sync this branch before creating a ${copy.reviewLabel}.`
    case 'auth_required':
      return `Create ${copy.shortLabel} failed: ${copy.providerName} is not authenticated. Next step: ${resolveHostedReviewAuthInstruction(eligibility.provider)} in this environment.`
    case 'detached_head':
    case 'existing_review':
    case 'fork_head_unsupported':
    case 'unsupported_provider':
    case null:
      return null
  }
}
