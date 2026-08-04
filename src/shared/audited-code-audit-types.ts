// Closed vocabularies for Phase 7: candidate identity and the Codex code audit.
//
// Separate from audited-workflow-types.ts for the same reason
// audited-plan-artifact-types.ts is: widening a union here must break the
// renderer's exhaustive switches (lint:switch-exhaustiveness) rather than fall
// through.
//
// DELIBERATELY ABSENT: a verdict vocabulary. Code-audit verdicts use the EXISTING
// ReviewVerdict ('approved' | 'fixes_requested' | 'blocked'). There is one
// verdict vocabulary in this feature and this phase does not add a second.
import type { ReviewVerdict } from './audited-workflow-types'

export const CANDIDATE_STATUSES = ['current', 'superseded'] as const
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

// Failures of candidate DERIVATION specifically — distinct from audit-run
// failures, because none of these ever reached a model.
export const CANDIDATE_REASON_CODES = [
  // The implementation changed nothing: the candidate tree equals base^{tree}.
  'empty_change_set',
  // A Git command in the derivation sequence failed, or produced a non-OID.
  'candidate_derivation_failed',
  // Non-local execution host (WSL distro or a non-local hostId). The audited
  // workflow has no path translation, so deriving would produce a wrong OID.
  'candidate_host_unsupported',
  // The repository's common object dir could not be resolved, or resolves to a
  // path that cannot be expressed as a single alternate entry.
  'candidate_path_unsupported',
  // This execution run already produced a candidate — a duplicate derivation.
  'duplicate_candidate'
] as const
export type CandidateReasonCode = (typeof CANDIDATE_REASON_CODES)[number]

// `running` is the only non-terminal status, mirroring PlanReviewRunStatus.
export const CODE_AUDIT_RUN_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted'
] as const
export type CodeAuditRunStatus = (typeof CODE_AUDIT_RUN_STATUSES)[number]

// Failures only — success is the `ok: true` arm of a discriminated result.
export const CODE_AUDIT_REASON_CODES = [
  'illegal_transition',
  'lock_contended',
  'worktree_not_verified',
  'worktree_identity_changed',
  // No 'current' candidate exists for the task.
  'candidate_unavailable',
  // The run's candidate is no longer the task's current one. Set at admission
  // (nothing spawned) and at finalization (verdict discarded).
  'candidate_superseded',
  // The worktree content changed, so the recomputed tree no longer matches the
  // candidate this run was admitted against. The block code that has been
  // declared since Phase 1 finally gets its producer.
  'candidate_drift',
  // The task moved out of awaiting_code_audit while this run was in flight.
  'task_state_changed',
  // A Claude execution (an implement or fix run) is live for this task. The
  // worktree is actively changing, so no audit may be admitted against it.
  // NOT retryable-by-button: it clears on its own when the run ends.
  'execution_in_progress',
  // A code audit is live, so a completing fix may not supersede the candidate it
  // is judging. Also not retryable-by-button.
  'code_audit_in_progress',
  // The fix round cap is reached.
  'round_limit_reached',
  // Phase 8 §0.2: the durable candidate store has no room for this candidate's
  // measured footprint, so it could never be promoted at commit time. Checked
  // BEFORE spawning Codex so the budget is visible at admission rather than
  // discovered at commit. Carries a ManifestReasonCode detail internally.
  'candidate_store_quota_exceeded',
  // Derivation-side failures surfaced on the audit lane.
  'empty_change_set',
  'candidate_derivation_failed',
  'candidate_host_unsupported',
  'candidate_path_unsupported',
  // Provider/process failures, mirroring PLAN_REVIEW_REASON_CODES.
  'provider_not_configured',
  'provider_settings_invalid',
  'credential_delivery_unavailable',
  'provider_storage_unavailable',
  'launch_plan_invalid',
  'codex_not_found',
  'spawn_failed',
  'exit_nonzero',
  'empty_output',
  'output_too_large',
  'timeout',
  'cancelled_by_user',
  'interrupted',
  'verdict_unparseable',
  'unexpected_commit_detected'
] as const
export type CodeAuditReasonCode = (typeof CODE_AUDIT_REASON_CODES)[number]

/**
 * Server-side authority for whether Retry Audit is admissible.
 *
 * Deliberately absent: `verdict_unparseable` and `output_too_large` (a rerun
 * against the same candidate reproduces them), `candidate_superseded`,
 * `candidate_drift`, and `task_state_changed` (not failures of this run — the
 * work moved on), `cancelled_by_user` (not a failure),
 * `unexpected_commit_detected` (drift the audit cannot undo), and every
 * admission code, none of which reached a spawn.
 *
 * `execution_in_progress` and `code_audit_in_progress` are ALSO absent, and for a
 * different reason: they are transient busy states that clear by themselves, so
 * a Retry button would race the very run that is holding the lane. The UI reports
 * "busy" instead.
 */
export const RETRYABLE_CODE_AUDIT_REASON_CODES: readonly CodeAuditReasonCode[] = [
  'exit_nonzero',
  'timeout',
  'interrupted',
  'spawn_failed',
  'codex_not_found',
  'empty_output',
  'worktree_identity_changed',
  'provider_storage_unavailable'
]

export function isRetryableCodeAuditReasonCode(code: CodeAuditReasonCode): boolean {
  return RETRYABLE_CODE_AUDIT_REASON_CODES.includes(code)
}

// Matches the existing CHECK(fix_round BETWEEN 0 AND 3) on audited_tasks.
// fixRound counts COMPLETED fix rounds; the cap is checked when STARTING a fix,
// never when auditing — a round-3 candidate must remain auditable and approvable,
// exactly as MAX_PLAN_ROUNDS behaves in the plan lane.
export const MAX_FIX_ROUNDS = 3

// The verdict a Codex code audit produced. Named alias over the ONE vocabulary so
// call sites read intently without inventing a parallel union.
export type CodeAuditVerdict = ReviewVerdict
