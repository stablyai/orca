import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import type { GitHubPRRefreshReason } from '../../../../shared/types'

type ChecksPanelPRRefreshRequestInput = {
  cachedHasPR: boolean | null
  cachedFetchedAt: number | null
  panelVisibleSince: number | null
  // A known-but-unrendered review needs one foreground lookup to resolve its transient state.
  hasUnrenderedReviewEvidence?: boolean
  hasRequestedForegroundRefresh?: boolean
}

type ChecksPanelPRRefreshRequest = {
  reason: GitHubPRRefreshReason
  priority: number
}

type ChecksPanelReviewEvidenceProviderInput = {
  linkedGitHubPR: number | null
  linkedGitLabMR: number | null
  linkedBitbucketPR: number | null
  linkedAzureDevOpsPR: number | null
  linkedGiteaPR: number | null
  eligibilityProvider?: HostedReviewProvider | undefined
  cachedProvider?: HostedReviewProvider | undefined
}

type ChecksPanelForegroundReviewEvidenceKeyInput = {
  refreshContextKey: string
  reviewEvidenceIdentity: number | string
  reviewEvidenceProvider?: HostedReviewProvider | undefined
  hasUnrenderedReviewEvidence: boolean
  isGitHubReviewContext: boolean
}

export function resolveChecksPanelReviewEvidenceProvider(
  input: ChecksPanelReviewEvidenceProviderInput
): HostedReviewProvider | undefined {
  if (input.linkedGitHubPR !== null) {
    return 'github'
  }
  if (input.linkedGitLabMR !== null) {
    return 'gitlab'
  }
  if (input.linkedBitbucketPR !== null) {
    return 'bitbucket'
  }
  if (input.linkedAzureDevOpsPR !== null) {
    return 'azure-devops'
  }
  if (input.linkedGiteaPR !== null) {
    return 'gitea'
  }
  return input.eligibilityProvider ?? input.cachedProvider
}

export function getChecksPanelForegroundReviewEvidenceKey(
  input: ChecksPanelForegroundReviewEvidenceKeyInput
): string | null {
  if (
    !input.hasUnrenderedReviewEvidence ||
    !input.isGitHubReviewContext ||
    (input.reviewEvidenceProvider !== undefined && input.reviewEvidenceProvider !== 'github')
  ) {
    return null
  }
  return `${input.refreshContextKey}::github::${input.reviewEvidenceIdentity}`
}

export function resolveChecksPanelPRRefreshRequest(
  input: ChecksPanelPRRefreshRequestInput
): ChecksPanelPRRefreshRequest {
  const cachedMissPredatesVisiblePanel =
    input.cachedHasPR === false &&
    input.cachedFetchedAt !== null &&
    input.panelVisibleSince !== null &&
    input.cachedFetchedAt < input.panelVisibleSince
  const unresolvedEvidenceNeedsForeground =
    input.hasUnrenderedReviewEvidence && input.cachedHasPR !== true

  if (
    !input.hasRequestedForegroundRefresh &&
    (cachedMissPredatesVisiblePanel || unresolvedEvidenceNeedsForeground)
  ) {
    // A stale miss or new positive evidence needs one foreground lookup to recover.
    return { reason: 'active', priority: 80 }
  }

  return { reason: 'swr', priority: 30 }
}
