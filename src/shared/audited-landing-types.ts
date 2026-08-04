// Closed vocabularies for Phase 10: fast-forwarding a Phase 8 commit into the
// user's SOURCE repository, locally.
//
// Separate from audited-workflow-types.ts for the same reason
// audited-commit-types.ts and audited-publish-types.ts are: widening a union here
// must break the renderer's exhaustive switches (lint:switch-exhaustiveness)
// rather than fall through.
//
// DELIBERATELY ABSENT from the FAILURE union: every condition observable only
// AFTER the source ref provably moved. Reporting one as a failure would lie about
// durable state and invite a duplicate land, so they live in
// LANDING_ADVISORY_CODES and `landing_advisory` NEVER holds a LandingReasonCode.

/**
 * Phase 10 local-integration lane.
 *
 * The first thirteen members have been declared since Phase 1 and were reserved
 * for this lane; Phase 10 is their first WRITER and EXTENDS the union rather than
 * redefining it. `integration_required` is the non-fast-forward case: the source
 * branch genuinely diverged and a real merge/rebase is needed, which this lane
 * will never attempt.
 *
 * Re-exported from audited-workflow-types.ts so every existing import still
 * resolves; it lives here so that file stays within its max-lines budget.
 */
export const LANDING_REASON_CODES = [
  'landed',
  'landed_recovered',
  'integration_required',
  'task_not_committed',
  'committed_candidate_invalid',
  'source_repo_mismatch',
  'source_repo_missing',
  'source_repo_dirty',
  'source_repo_detached_or_invalid_branch',
  'source_repo_not_at_base_commit',
  'source_repo_already_at_candidate',
  'fast_forward_failed',
  'lock_contended',
  // Phase 10 additions.
  'illegal_transition',
  'landing_host_unsupported',
  'worktree_not_verified',
  'worktree_identity_changed',
  // The Phase 8 binding does not hold.
  'commit_attempt_not_completed',
  // THE PHASE 9 PUBLICATION GATE. A local commit without a CONFIRMED publication
  // must not land: landing writes the user's own working tree, and doing so for
  // work no remote has ever seen would make the source repo depend on it.
  'task_not_published',
  'publish_sha_mismatch',
  'publish_not_confirmed',
  'publish_in_progress',
  // Cross-lane exclusion.
  'execution_in_progress',
  'code_audit_in_progress',
  // The checked-out fast-forward requires the branch checked out at the RECORDED
  // source repo path. A branch held by some other worktree is refused, because
  // moving it would desynchronize that worktree's index.
  'source_repo_branch_not_checked_out',
  // Partial or unexplained evidence: stays guarded, never auto-remediated.
  'landing_evidence_ambiguous',
  // Set only by startup/recheck reconciliation when a crash left a land attempt
  // `authorized` with no writer left to finish it. Retryable.
  'interrupted'
] as const
export type LandingReasonCode = (typeof LANDING_REASON_CODES)[number]

/**
 * Conditions observed AFTER the fast-forward ref update is confirmed.
 *
 * Kept out of LANDING_REASON_CODES on purpose: by the time any of these can be
 * written, the source branch provably carries the audited SHA. The user's history
 * HAS moved, so the only truthful report is "landed, with a caveat".
 *
 * This union is the COMPLETE post-durability contract — every non-fatal
 * post-ref-update result maps to exactly one member.
 */
export const LANDING_ADVISORY_CODES = [
  // The ref moved but `read-tree -m -u` did not apply. The index and working tree
  // still describe the pre-land state; the user must refresh them by hand.
  'worktree_update_failed',
  // The post-land re-read could not confirm the expected end state.
  'worktree_verify_failed',
  // Files changed under us while the update ran.
  'source_repo_drifted'
] as const
export type LandingAdvisoryCode = (typeof LANDING_ADVISORY_CODES)[number]

/**
 * Land-attempt lifecycle. Same split-failure doctrine as
 * COMMIT_ATTEMPT_STATUSES and PUBLISH_ATTEMPT_STATUSES: a land whose outcome
 * could not be read is precisely the partial-evidence case that must stay
 * guarded, so there is no bare `failed`.
 *
 * `authorized` additionally doubles as the resting state for an UNKNOWN outcome —
 * the attempt stays live until an evidence read (startup sweep or the user's
 * Recheck) can classify it, which is what stops a crash from becoming a second
 * ref update.
 */
export const LAND_ATTEMPT_STATUSES = [
  'authorized',
  'completed',
  'failed_no_effect',
  'failed_ambiguous',
  'abandoned'
] as const
export type LandAttemptStatus = (typeof LAND_ATTEMPT_STATUSES)[number]

/**
 * What an evidence read concluded about an interrupted land.
 *
 * `ref_moved` and `ref_moved_worktree_partial` are BOTH durable outcomes — the
 * distinction is only whether the index/worktree update also ran, which selects
 * the advisory. Collapsing them would either lose the caveat or fabricate one.
 */
export const LANDING_CLASSIFICATIONS = [
  'exact_completion',
  'ref_moved',
  'ref_moved_worktree_partial',
  'no_effect',
  'ambiguous'
] as const
export type LandingClassification = (typeof LANDING_CLASSIFICATIONS)[number]

/**
 * Server-side authority for whether Retry Land is admissible.
 *
 * Deliberately absent: `landing_evidence_ambiguous` (never auto-remediated),
 * `integration_required` (the branches genuinely diverged — a retry needs a human
 * merge decision), every identity code (`source_repo_mismatch`,
 * `source_repo_missing`, `source_repo_detached_or_invalid_branch`), and ALL FOUR
 * publication-gate codes: each needs a successful Publish first, which is a
 * different command, not a Land-button retry.
 *
 * This governs ONLY the Land button. An attempt whose outcome is UNKNOWN is a
 * different situation entirely: it stays `authorized` and offers Recheck.
 */
export const RETRYABLE_LANDING_REASON_CODES: readonly LandingReasonCode[] = [
  'lock_contended',
  'source_repo_dirty',
  'source_repo_not_at_base_commit',
  'source_repo_branch_not_checked_out',
  'interrupted'
]

export function isRetryableLandingReasonCode(code: LandingReasonCode): boolean {
  return RETRYABLE_LANDING_REASON_CODES.includes(code)
}

/**
 * The landing lane's contribution to AuditedTaskStatusProjection.
 *
 * Declared here rather than inline so the lane's whole boundary contract reviews
 * as one unit; it is intersected into the projection type in
 * audited-workflow-types.ts.
 *
 * `landed` is TERMINAL, so unlike the publish lane's fields these describe a
 * state the task can rest in permanently. landedShaShort is the 12-char form —
 * landed_sha and landed_base_sha never cross in full, exactly like committedSha,
 * and the source repo path never crosses at all.
 */
export type AuditedTaskLandingProjection = {
  landAttemptStatus: LandAttemptStatus | null
  landedShaShort: string | null
  landingReasonCode: LandingReasonCode | null
  /**
   * ALWAYS a LandingAdvisoryCode, never a LandingReasonCode: once the source ref
   * provably moved, every remaining condition is advisory-only. A task may be
   * `landed` with a valid landedShaShort AND carry
   * `worktree_update_failed`. Rendering that as a failed land would lie about
   * durable state, so the two never share a field.
   */
  landingAdvisoryCode: LandingAdvisoryCode | null
  /**
   * Server-computed authorities. landReady additionally requires the Phase 9
   * publication binding, so a renderer bug cannot manufacture a Land affordance
   * for unpublished work. landReady and landRecheckAvailable are MUTUALLY
   * EXCLUSIVE by construction — both test landAttemptStatus.
   */
  landReady: boolean
  landRecheckAvailable: boolean
  landRetryAvailable: boolean
}
