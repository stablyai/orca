// Closed vocabularies for Phase 9: publishing a Phase 8 commit to the remote and
// creating a provider-neutral review request.
//
// Separate from audited-workflow-types.ts for the same reason
// audited-commit-types.ts is: widening a union here must break the renderer's
// exhaustive switches (lint:switch-exhaustiveness) rather than fall through.
//
// DELIBERATELY ABSENT from the FAILURE union: every review-request outcome. Each
// can only be observed AFTER the push is proven durable, so `reason_code` — the
// column a FAILED attempt writes — is the wrong carrier. They live in
// PUBLISH_ADVISORY_CODES, and publish_advisory NEVER holds a PublishReasonCode.

// Failures only — success is the `ok: true` arm of a discriminated result.
export const PUBLISH_REASON_CODES = [
  'illegal_transition',
  'lock_contended',
  // Admission — the Phase 8 binding.
  'task_not_committed',
  'committed_sha_missing',
  'commit_attempt_not_completed',
  'commit_attempt_sha_mismatch',
  'publish_host_unsupported',
  'worktree_not_verified',
  'worktree_identity_changed',
  // Immediate pre-push re-verification. These run AFTER verifyWorktreeForTask
  // awaits, because that snapshot is stale by the time the push would spawn.
  'head_not_at_committed_sha',
  'branch_tip_not_at_committed_sha',
  'branch_not_symbolic',
  // Remote topology.
  'no_remote_configured',
  'remote_url_unreadable',
  'remote_ref_unreadable',
  // Push.
  'push_rejected_stale_lease',
  'push_rejected_non_fast_forward',
  'push_auth_failed',
  'push_network_unavailable',
  'push_failed',
  'push_evidence_ambiguous',
  'interrupted'
] as const
export type PublishReasonCode = (typeof PUBLISH_REASON_CODES)[number]

/**
 * Conditions observed AFTER the push is confirmed on the remote.
 *
 * Kept out of PUBLISH_REASON_CODES on purpose: by the time any of these can be
 * written, the remote ref provably carries the audited SHA. Reporting one as a
 * failure would be a lie that also invites a duplicate push.
 *
 * This union is the COMPLETE post-confirmation contract — every terminal
 * review-request result maps to exactly one member.
 */
export const PUBLISH_ADVISORY_CODES = [
  // Nothing further to do.
  'review_request_created',
  'review_request_already_exists',
  // Terminal for this provider: retrying creation cannot help.
  'review_request_unsupported_provider',
  // Actionable by the human, then retryable via createReviewRequest.
  'review_request_auth_required',
  'review_request_validation_failed',
  // Retryable as-is.
  'review_request_deferred',
  // Never guessed either way.
  'review_request_ambiguous'
] as const
export type PublishAdvisoryCode = (typeof PUBLISH_ADVISORY_CODES)[number]

/**
 * Server-side authority for whether Retry Publish is admissible.
 *
 * Deliberately absent: `push_rejected_stale_lease` (the remote genuinely moved —
 * a retry needs a human decision about whose work wins), `push_evidence_ambiguous`
 * (never auto-remediated), `push_auth_failed` (needs credential setup, not a
 * button), and every admission/pre-push code (the underlying state must change
 * first).
 *
 * This governs ONLY the Publish button. An attempt whose outcome is UNKNOWN is a
 * different situation entirely: it stays `authorized` and offers Recheck outcome,
 * never Retry.
 */
export const RETRYABLE_PUBLISH_REASON_CODES: readonly PublishReasonCode[] = [
  'lock_contended',
  'push_network_unavailable',
  'remote_ref_unreadable',
  'interrupted'
]

export function isRetryablePublishReasonCode(code: PublishReasonCode): boolean {
  return RETRYABLE_PUBLISH_REASON_CODES.includes(code)
}

/**
 * Advisories for which the separate "Create review request" action is offered.
 *
 * `review_request_ambiguous` is retryable ONLY because the creation path is
 * duplicate-safe: it re-queries for an open review on the branch and adopts one
 * if present, so a retry cannot produce a second review request.
 *
 * Absent: the two success codes (nothing to retry) and
 * `review_request_unsupported_provider` (no auth or edit makes this provider
 * able to create a review).
 */
export const REVIEW_REQUEST_RETRYABLE_ADVISORY_CODES: readonly PublishAdvisoryCode[] = [
  'review_request_auth_required',
  'review_request_validation_failed',
  'review_request_deferred',
  'review_request_ambiguous'
]

export function canRetryReviewRequest(code: PublishAdvisoryCode | null): boolean {
  return code !== null && REVIEW_REQUEST_RETRYABLE_ADVISORY_CODES.includes(code)
}

/**
 * What an evidence read concluded about an interrupted push.
 *
 * `unknown_remote` is NOT a failure: distinguishing "we could not look" from "it
 * did not happen" is the entire point of keeping it separate. Collapsing them
 * would either strand a published branch as failed or invite a duplicate push.
 */
export const PUBLISH_CLASSIFICATIONS = [
  'published',
  'no_effect',
  'ambiguous',
  'unknown_remote'
] as const
export type PublishClassification = (typeof PUBLISH_CLASSIFICATIONS)[number]
