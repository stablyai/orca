import type { CheckStatus, ProviderCheckSummary } from './github/pull-request-types'
import { resolveProviderCheckState } from './provider-check-summary'
import type { WorkspaceAttachment } from './worktree/types'
import {
  getWorkspaceAttachmentKey,
  getWorkspaceAttachmentUrlScope,
  normalizeWorkspaceAttachments
} from './workspace-attachment-normalization'

export type WorkspaceReviewCheckDetails = {
  stale?: boolean
  review?: { provider: string; number: number; url?: string; status?: CheckStatus }
}

export type WorkspaceReviewChecksSummary = Omit<ProviderCheckSummary, 'state'> & {
  state: ProviderCheckSummary['state'] | 'unknown'
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
    pending: 0,
    neutral: 0
  }
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
    if (!matches || !review.status) {
      summary.unknown += 1
      continue
    }
    summary.known += 1
    if (detail?.stale) {
      summary.stale += 1
    }
    if (review.status === 'failure') {
      summary.failed += 1
    } else if (review.status === 'pending') {
      summary.pending += 1
    } else if (review.status === 'success') {
      summary.passed += 1
    } else {
      summary.neutral += 1
    }
  }
  const state = resolveProviderCheckState(summary)
  // Missing or stale reviews cannot certify the workspace green; known failures still count.
  summary.state =
    state !== 'failure' && state !== 'pending' && (summary.unknown > 0 || summary.stale > 0)
      ? 'unknown'
      : state
  return summary
}
