import type { CheckStatus, ProviderCheckSummary } from './github/pull-request-types'
import type { HostedReviewState } from './source-control/hosted-review/hosted-review-contracts'
import {
  resolveProviderCheckState,
  getProviderChecksOutcome
} from './source-control/checks/provider-check-summary'
import type { WorkspaceAttachment } from './worktree/types'
import {
  getWorkspaceAttachmentKey,
  getWorkspaceAttachmentUrlScope,
  normalizeWorkspaceAttachments
} from './workspace-attachment-normalization'

export type WorkspaceReviewCheckDetails = {
  stale?: boolean
  review?: {
    provider: string
    number: number
    url?: string
    state?: HostedReviewState
    status?: CheckStatus
    checksSummary?: ProviderCheckSummary
  }
}

export type WorkspaceReviewChecksSummary = Omit<ProviderCheckSummary, 'state'> & {
  state: ProviderCheckSummary['state'] | 'unknown'
  reviewState?: HostedReviewState
  known: number
  unknown: number
  stale: number
}

export function summarizeWorkspaceReviewChecks(
  attachments: readonly WorkspaceAttachment[],
  details: Readonly<Record<string, WorkspaceReviewCheckDetails | undefined>>
): WorkspaceReviewChecksSummary {
  const reviews = normalizeWorkspaceAttachments(attachments).filter((item) => item.type !== 'issue')
  const summary: WorkspaceReviewChecksSummary = {
    state: 'none',
    total: reviews.length,
    known: 0,
    unknown: 0,
    stale: 0,
    passed: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
    neutral: 0
  }
  const reviewStates = new Set<HostedReviewState | undefined>()
  for (const item of reviews) {
    const detail = details[getWorkspaceAttachmentKey(item)]
    const review = detail?.review
    const matches =
      review &&
      review.provider === item.provider &&
      review.number === item.number &&
      (!item.url ||
        (review.url &&
          getWorkspaceAttachmentUrlScope(item) ===
            getWorkspaceAttachmentUrlScope({ ...item, url: review.url })))
    reviewStates.add(matches ? review.state : undefined)
    if (matches && detail?.stale) {
      summary.stale += 1
    }
    if (!matches || !review.status) {
      summary.unknown += 1
      continue
    }
    summary.known += 1
    const outcome = getProviderChecksOutcome(review.checksSummary, review.status)
    if (outcome === 'cancelled') {
      summary.failed += 1
      summary.cancelled = (summary.cancelled ?? 0) + 1
    } else if (outcome === 'failure') {
      summary.failed += 1
    } else if (outcome === 'pending') {
      summary.pending += 1
    } else if (outcome === 'success') {
      summary.passed += 1
    } else {
      summary.neutral += 1
    }
  }
  if (reviewStates.size === 1) {
    summary.reviewState = reviewStates.values().next().value
  } else if (reviewStates.has('open') || reviewStates.has('draft')) {
    summary.reviewState = 'open'
  } else if (reviewStates.size > 1 && !reviewStates.has(undefined)) {
    summary.reviewState = 'closed'
  }
  const state = resolveProviderCheckState(summary)
  const outcome = getProviderChecksOutcome({ ...summary, state })
  // Missing or stale reviews cannot certify the workspace green; known failures still count.
  summary.state =
    outcome !== 'failure' && outcome !== 'pending' && (summary.unknown > 0 || summary.stale > 0)
      ? 'unknown'
      : state
  return summary
}
