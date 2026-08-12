import type { HostedReviewCreationBlockedReason } from '../../../../shared/hosted-review'
import type { GitHubPRRefreshSkippedReason, PRRefreshErrorType } from '../../../../shared/types'
import type { ChecksPanelReviewLookup } from './checks-panel-review-lookup-authority'

/**
 * Composer visibility the panel should render. Phase 1 never *opens* a new
 * composer from a refresh failure — `confirmed_open` / `needs_push_open` mean an
 * already-confirmed composer stays open. (Phase 2's disabled draft-preserve mode
 * is intentionally absent until that phase ships.)
 */
export type ChecksPanelComposerMode = 'hidden' | 'confirmed_open' | 'needs_push_open'

export type ChecksPanelWorkflowAction =
  | 'create'
  | 'push_and_create'
  | 'publish_branch'
  | 'sync_branch'
  | 'authenticate'
  | null

export type ChecksPanelRecoveryAction = 'retry' | 'refresh' | 'open_review'

export type ChecksPanelReviewState = {
  /** True only for `reviewLookup: found` — the caller renders review chrome. */
  renderReview: boolean
  title: string
  description: string
  /** One muted sentence appended beneath the body (concurrent lookup failure). */
  detail?: string
  composerMode: ChecksPanelComposerMode
  workflowAction: ChecksPanelWorkflowAction
  recovery: ChecksPanelRecoveryAction[]
  openReviewUrl?: string | null
  /** Drives "Orca will retry at {time}"; only when a future auto-retry exists. */
  autoRetryAt?: number
  /** Retry button stays disabled while now < retryDisabledUntil. */
  retryDisabledUntil?: number
}

export type ChecksPanelRefreshInput = {
  status?: 'queued' | 'in-flight' | 'paused' | 'error' | 'skipped'
  errorType?: PRRefreshErrorType
  skippedReason?: GitHubPRRefreshSkippedReason
  nextAutoRetryAt?: number
  retryDisabledUntil?: number
}

export type ChecksPanelReviewStateInput = {
  operationLabel: string | null
  reviewLabel: 'pull request' | 'merge request'
  reviewShortLabel: 'PR' | 'MR'
  /** Localized provider display name, e.g. "GitHub". */
  providerName: string
  /** GitHub gets typed error rows; other providers use neutral copy. */
  isGitHubProvider: boolean
  reviewLookup: ChecksPanelReviewLookup
  openReviewUrl: string | null
  eligibilityBlockedReason: HostedReviewCreationBlockedReason | undefined
  /** Confirmed readiness held for the exact context (see review-creation). */
  confirmedReadiness: boolean
  /** The confirmed path is the Push & Create workflow rather than plain Create. */
  confirmedNeedsPush: boolean
  refresh?: ChecksPanelRefreshInput
  gitStatusPhase: 'loading' | 'ready' | 'error'
  hasUpstream: boolean | undefined
  hasCurrentBranch: boolean
}

export const HARD_REFRESH_ERROR_TYPES = new Set<PRRefreshErrorType>([
  'auth',
  'permission',
  'repo_unavailable',
  'gh_unavailable'
])

/** Eligibility blockers that own their own guidance and outrank refresh copy. */
export const ELIGIBILITY_SAFETY_BLOCKERS = new Set<NonNullable<HostedReviewCreationBlockedReason>>([
  'detached_head',
  'dirty',
  'default_branch',
  'existing_review',
  'fork_head_unsupported',
  'base_not_on_remote',
  'unsupported_provider'
])

export function isHardRefreshError(refresh: ChecksPanelRefreshInput | undefined): boolean {
  return (
    refresh?.status === 'error' &&
    refresh.errorType != null &&
    HARD_REFRESH_ERROR_TYPES.has(refresh.errorType)
  )
}

export function isRateLimitRefresh(refresh: ChecksPanelRefreshInput | undefined): boolean {
  return (
    refresh?.status === 'paused' ||
    refresh?.errorType === 'rate_limited' ||
    (refresh?.status === 'skipped' && refresh.skippedReason === 'rate-limit')
  )
}

export function isTransientRefreshFailure(refresh: ChecksPanelRefreshInput | undefined): boolean {
  if (!refresh) {
    return false
  }
  if (isRateLimitRefresh(refresh)) {
    return true
  }
  if (refresh.status === 'error') {
    // Untyped and typed-transient errors only pause background refresh; they do
    // not prove a fresh user-initiated lookup would fail.
    return (
      refresh.errorType == null ||
      refresh.errorType === 'network' ||
      refresh.errorType === 'server_error' ||
      refresh.errorType === 'unknown'
    )
  }
  return false
}

export function isBranchBlocker(reason: HostedReviewCreationBlockedReason | undefined): boolean {
  return (
    reason === 'no_upstream' ||
    reason === 'needs_sync' ||
    reason === 'auth_required' ||
    reason === 'needs_push'
  )
}

export function confirmedComposerMode(
  input: Pick<ChecksPanelReviewStateInput, 'confirmedReadiness' | 'confirmedNeedsPush'>
): ChecksPanelComposerMode {
  if (!input.confirmedReadiness) {
    return 'hidden'
  }
  return input.confirmedNeedsPush ? 'needs_push_open' : 'confirmed_open'
}

export function workflowActionForComposer(
  mode: ChecksPanelComposerMode
): ChecksPanelWorkflowAction {
  if (mode === 'confirmed_open') {
    return 'create'
  }
  if (mode === 'needs_push_open') {
    return 'push_and_create'
  }
  return null
}

export function autoRetrySchedule(input: ChecksPanelReviewStateInput): {
  autoRetryAt?: number
  retryDisabledUntil?: number
} {
  return {
    autoRetryAt: input.refresh?.nextAutoRetryAt,
    retryDisabledUntil: input.refresh?.retryDisabledUntil
  }
}

export function capitalizeReviewLabel(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value
}
