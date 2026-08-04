// Closed vocabularies for Phase 8: human approval and the two-phase local commit.
//
// Separate from audited-workflow-types.ts for the same reason
// audited-code-audit-types.ts is: widening a union here must break the renderer's
// exhaustive switches (lint:switch-exhaustiveness) rather than fall through.
//
// DELIBERATELY ABSENT: post_commit_drift_detected. It can only arise once the
// commit is durable, so putting it in the FAILURE union would invite a caller to
// report a successful commit as failed. It lives in COMMIT_ADVISORY_CODES below.

// Failures only — success is the `ok: true` arm of a discriminated result.
export const COMMIT_REASON_CODES = [
  'illegal_transition',
  'lock_contended',
  // Approval-gate failures.
  'no_approval',
  'approval_expired',
  'approval_revoked',
  'approval_already_consumed',
  'approval_binding_mismatch',
  // Candidate freshness.
  'candidate_superseded',
  'candidate_drift',
  'worktree_not_verified',
  'worktree_identity_changed',
  'execution_in_progress',
  'code_audit_in_progress',
  // Message canonicalization, mirroring MESSAGE_REASON_CODES one-for-one.
  'message_empty_subject',
  'message_contains_nul',
  'message_too_large',
  'message_invalid_encoding',
  // Phase A0. The durable candidate store is missing/expired, so the approved
  // graph cannot be promoted. The remedy is a fresh code audit — NEVER a re-hash
  // of the worktree, which would reintroduce the object-storage leak.
  'candidate_objects_unavailable',
  'promotion_failed',
  'promoted_tree_unresolvable',
  'materialization_failed',
  // The worktree changed, so the re-derived tree no longer equals the approved
  // one. Not retryable-by-button: a rerun reproduces it until a fresh audit.
  'materialized_tree_mismatch',
  // Phase A / B.
  'commit_tree_failed',
  'ref_update_failed',
  'branch_ref_moved',
  'commit_host_unsupported',
  // Phase C. Recorded as an ADVISORY on a durable commit, never a block; present
  // here only so a pre-commit failure to prepare the refresh can be reported.
  'index_refresh_failed',
  'interrupted',
  'evidence_ambiguous'
] as const
export type CommitReasonCode = (typeof COMMIT_REASON_CODES)[number]

/**
 * Conditions observed AFTER the commit is durable.
 *
 * Kept out of COMMIT_REASON_CODES on purpose: by the time either can be written,
 * the commit object, the ref update, and committed_sha are all correct. Reporting
 * them as failures would be a lie that also invites a duplicate commit attempt.
 */
export const COMMIT_ADVISORY_CODES = ['post_commit_drift_detected', 'index_refresh_failed'] as const
export type CommitAdvisoryCode = (typeof COMMIT_ADVISORY_CODES)[number]

/**
 * Server-side authority for whether Retry Commit is admissible.
 *
 * Deliberately absent: `materialized_tree_mismatch`, `candidate_drift`,
 * `candidate_superseded` (the work moved on — a rerun reproduces them),
 * `candidate_objects_unavailable` (needs a fresh audit, not a retry),
 * every approval-gate code (the human must re-approve), and the message codes
 * (the same message fails the same way).
 *
 * `execution_in_progress` and `code_audit_in_progress` are ALSO absent, and for a
 * different reason: they are transient busy states that clear by themselves, so a
 * Retry button would race the very run holding the lane.
 */
export const RETRYABLE_COMMIT_REASON_CODES: readonly CommitReasonCode[] = [
  'lock_contended',
  'promotion_failed',
  'commit_tree_failed',
  'ref_update_failed',
  'interrupted'
]

export function isRetryableCommitReasonCode(code: CommitReasonCode): boolean {
  return RETRYABLE_COMMIT_REASON_CODES.includes(code)
}

// Server-side approval durations. The renderer names a preset, never a duration.
export const APPROVAL_TTL_DURATIONS_MS: Record<'short' | 'standard' | 'extended', number> = {
  short: 5 * 60 * 1000,
  standard: 30 * 60 * 1000,
  extended: 4 * 60 * 60 * 1000
}

// Commit message bounds. 32KB matches the IPC Zod ceiling; both are enforced.
export const MAX_COMMIT_MESSAGE_BYTES = 32 * 1024

// §0.2 quota bounds. Per-candidate limits count LOGICAL source bytes (they
// express "this change set is too large to audit", which compression must not
// disguise). The global budget counts DURABLE on-disk object bytes, because it
// bounds what the user's disk actually holds. Measured divergence between the two
// is ~226x on highly compressible input, so they are never interchangeable.
export const CANDIDATE_STORE_LIMITS = {
  perFileLogicalBytes: 8 * 1024 * 1024,
  untrackedFileCount: 2000,
  untrackedTotalLogicalBytes: 32 * 1024 * 1024,
  candidateGraphLogicalBytes: 64 * 1024 * 1024,
  trackedChangeLogicalBytes: 64 * 1024 * 1024,
  globalDurableBytes: 512 * 1024 * 1024
} as const

// §0.3. A candidate store older than this is reclaimed by the startup sweep even
// when its candidate is still `current` — what stops a task blocked forever from
// retaining source blobs indefinitely.
export const CANDIDATE_STORE_RETENTION_TTL_MS = 14 * 24 * 60 * 60 * 1000

// §0.2. How long a reservation may sit `held` before startup recovery treats it
// as abandoned. DIAGNOSTIC + startup-recovery evidence ONLY: elapsed time NEVER
// releases a reservation, because a promotion may still be writing bytes.
export const STORE_RESERVATION_TTL_MS = 60 * 60 * 1000
