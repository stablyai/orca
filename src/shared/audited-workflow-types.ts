// Closed vocabularies and sanitized contracts for the Audited Workflow feature.
// No free text crosses any IPC/renderer/notification boundary through these types —
// see docs/audited-workflow.md for the trust-boundary rationale.
import type { WorktreeReasonCode } from './audited-worktree-types'
import type { ExecutionReasonCode, ExecutionRunStatus } from './audited-execution-types'
import type { PlanReviewReasonCode, PlanReviewRunStatus } from './audited-plan-artifact-types'
// Type-only, so the cycle with audited-code-audit-types.ts (which imports
// ReviewVerdict from here) is erased at compile time — the same shape the plan
// and execution type modules already use.
import type { CodeAuditReasonCode, CodeAuditRunStatus } from './audited-code-audit-types'
import type { AuditMode } from './audited-audit-mode-types'
// Type-only, so the cycle with audited-commit-types.ts is erased at compile time.
import type { CommitAdvisoryCode, CommitReasonCode } from './audited-commit-types'
// Type-only, so the cycle with audited-publish-types.ts is erased at compile time.
import type { PublishAdvisoryCode, PublishReasonCode } from './audited-publish-types'
// Type-only. audited-landing-types.ts now OWNS the landing vocabularies and is
// re-exported from this file's tail, so nothing here imports back into it.
import type { AuditedTaskLandingProjection } from './audited-landing-types'
import type { HostedReviewProvider } from './hosted-review'

export const AUDITED_TASK_STATES = [
  'selected',
  'triaging',
  'planning',
  'awaiting_plan_review',
  'plan_fixes_requested',
  'ready_to_implement',
  'implementing',
  'awaiting_code_audit',
  'code_fixes_requested',
  'awaiting_human_approval',
  'committing',
  'committed',
  'landing',
  'landed',
  'blocked',
  'cancelled'
] as const
export type AuditedTaskState = (typeof AUDITED_TASK_STATES)[number]

export const AUDITED_PHASES = [
  'triage',
  'plan',
  'planReview',
  'implement',
  'fix',
  'codeAudit',
  'commit',
  'land'
] as const
export type AuditedPhase = (typeof AUDITED_PHASES)[number]

export const TRIAGE_DECISIONS = ['plan', 'direct'] as const
export type TriageDecision = (typeof TRIAGE_DECISIONS)[number]

export const RISK_LEVELS = ['low', 'medium', 'high'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

export const REVIEW_VERDICTS = ['approved', 'fixes_requested', 'blocked'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

export const RECONCILE_CLASSES = ['resumable', 'needs_attention', 'completed', 'failed'] as const
export type ReconcileClass = (typeof RECONCILE_CLASSES)[number]

// Server-side duration presets; the renderer never supplies a raw duration.
export const APPROVAL_TTL_PRESETS = ['short', 'standard', 'extended'] as const
export type ApprovalTtlPreset = (typeof APPROVAL_TTL_PRESETS)[number]

// `failed` is deliberately SPLIT, mirroring WORKTREE_ATTEMPT_STATUSES: a dangling
// commit object with no ref update is exactly the "partial evidence remains" case
// and must not collapse into a generic failure. failed_no_effect: the ref
// provably never moved, so nothing in the user's history changed.
// failed_ambiguous: partial/mismatched evidence remains and must stay guarded.
// There is no bare `failed`.
export const COMMIT_ATTEMPT_STATUSES = [
  'authorized',
  'completed',
  'failed_no_effect',
  'failed_ambiguous',
  'abandoned'
] as const
export type CommitAttemptStatus = (typeof COMMIT_ATTEMPT_STATUSES)[number]

// Phase 9. Same split-failure doctrine as COMMIT_ATTEMPT_STATUSES: a push whose
// outcome could not be read is precisely the partial-evidence case that must stay
// guarded, so there is no bare `failed`. `authorized` additionally doubles as the
// resting state for an UNKNOWN outcome — the attempt stays live until an
// evidence read (startup sweep or the user's Recheck) can classify it, which is
// what stops a lost acknowledgement from becoming a duplicate push.
export const PUBLISH_ATTEMPT_STATUSES = [
  'authorized',
  'completed',
  'failed_no_effect',
  'failed_ambiguous',
  'abandoned'
] as const
export type PublishAttemptStatus = (typeof PUBLISH_ATTEMPT_STATUSES)[number]

export const TASK_SOURCES = ['roadmap', 'custom'] as const
export type AuditedTaskSource = (typeof TASK_SOURCES)[number]

export const APPROVAL_STATES = ['none', 'pending', 'expired', 'consumed', 'revoked'] as const
export type AuditedApprovalState = (typeof APPROVAL_STATES)[number]

export const TASK_ACTORS = ['human', 'control', 'triage', 'claude', 'codex'] as const
export type AuditedTaskActor = (typeof TASK_ACTORS)[number]

export const BLOCK_REASON_CODES = [
  'triage_process_failed',
  'triage_output_invalid',
  'triage_override_refused',
  'plan_process_failed',
  'plan_output_empty',
  'plan_review_process_failed',
  'plan_review_unparseable',
  'plan_review_round_limit',
  'implement_process_failed',
  'fix_process_failed',
  'empty_change_set',
  'code_audit_process_failed',
  'code_audit_unparseable',
  'code_audit_round_limit',
  'candidate_drift',
  // Phase 3: the two generic worktree block codes. The detailed
  // WorktreeReasonCode is persisted separately in worktree_reason_code —
  // blockedReasonCode deliberately stays narrow (see audited-worktree-types.ts).
  'worktree_provision_failed',
  'worktree_drift_detected',
  'worktree_missing',
  'worktree_head_moved',
  'unexpected_commit_detected',
  'commit_attempt_evidence_ambiguous',
  'commit_parent_mismatch',
  'commit_tree_mismatch',
  'commit_message_mismatch',
  'commit_identity_mismatch',
  'staged_tree_mismatch',
  'branch_ref_moved',
  'branch_not_symbolic',
  'post_commit_drift_detected',
  // Phase 8: the commit lane's generic block code. The detailed CommitReasonCode
  // is persisted separately on the attempt row — blockedReasonCode stays narrow,
  // exactly as the worktree lane's two codes do.
  'commit_process_failed',
  // Phase 9: the publish lane's generic block code, reached ONLY by ambiguous
  // push evidence. The detailed PublishReasonCode is persisted separately on the
  // attempt row — blockedReasonCode stays narrow, as every other lane's does.
  'publish_process_failed',
  // Phase 10: the landing lane's generic block code, reached ONLY by ambiguous
  // land evidence. The detailed LandingReasonCode is persisted separately on the
  // attempt row — one generic code per lane, as every lane before it.
  'land_attempt_evidence_ambiguous',
  'claude_not_found',
  'codex_not_found',
  'agent_timeout',
  'agent_output_too_large',
  'model_selection_invalid',
  'unsupported_host',
  // Phase 1 vertical-slice specific: no real phases exist yet.
  'dev_transition_unavailable'
] as const
export type BlockReasonCode = (typeof BLOCK_REASON_CODES)[number]

// Candidate/manifest safety limits — every failure is a closed code.
export const MANIFEST_REASON_CODES = [
  'manifest_ok',
  'untracked_file_count_exceeded',
  'untracked_file_bytes_exceeded',
  'untracked_total_bytes_exceeded',
  'manifest_total_bytes_exceeded',
  'tracked_diff_bytes_exceeded',
  'path_outside_worktree',
  'path_not_canonical',
  'symlink_escapes_worktree',
  'special_file_rejected',
  'ambiguous_path_rejected',
  'file_changed_during_hashing',
  'file_unreadable'
] as const
export type ManifestReasonCode = (typeof MANIFEST_REASON_CODES)[number]

// Commit-message canonicalization.
export const MESSAGE_REASON_CODES = [
  'message_ok',
  'message_empty_subject',
  'message_contains_nul',
  'message_too_large',
  'message_invalid_encoding'
] as const
export type MessageReasonCode = (typeof MESSAGE_REASON_CODES)[number]

export const APPROVAL_REASON_CODES = [
  'approval_granted',
  'approval_consumed',
  'approval_revoked',
  'approval_expired',
  'not_awaiting_approval',
  'approver_identity_invalid',
  'worktree_missing_or_outside_managed_tree',
  'no_audit_approved_candidate',
  'candidate_identity_changed',
  'no_pending_approval',
  'approval_binding_mismatch',
  'approval_already_consumed',
  'ttl_preset_invalid',
  'lock_contended'
] as const
export type ApprovalReasonCode = (typeof APPROVAL_REASON_CODES)[number]

// Phase 10's LANDING_REASON_CODES lives in audited-landing-types.ts alongside the
// lane's other vocabularies, and is re-exported from this file's tail so every
// existing import keeps working.

// Closed reason codes for starting/running triage (Phase 2). Every expected
// failure — illegal/stale state, a concurrent CAS loss, no provider
// configured, a timeout, an invalid/unparseable model response, or an
// unexpected provider error — maps to exactly one of these. Never a raw
// exception message, HTTP body, prompt, or stack trace.
export const TRIAGE_REASON_CODES = [
  'illegal_transition',
  'lock_contended',
  'provider_unavailable',
  'provider_timeout',
  'provider_error',
  'output_invalid',
  // Set only by startup/init reconciliation when a process crash or restart
  // is discovered to have left a triage run 'running' with no writer left to
  // finish it. Retryable — a fresh Start Triage always begins a new run.
  'interrupted'
] as const
export type TriageReasonCode = (typeof TRIAGE_REASON_CODES)[number]

export const TRIAGE_RUN_STATUSES = ['running', 'succeeded', 'blocked'] as const
export type TriageRunStatus = (typeof TRIAGE_RUN_STATUSES)[number]

export const RECONCILE_REASON_CODES = [
  'ok',
  'no_active_phase',
  'task_dir_or_state_invalid',
  'worktree_path_outside_managed_tree',
  'worktree_missing',
  'worktree_head_unreadable',
  'worktree_head_base_commit_mismatch',
  'active_phase_without_live_lock',
  'lock_missing_expected_fields',
  'lock_holder_not_alive',
  'lock_live_owned_by_other_process',
  'lock_phase_active_phase_mismatch',
  'lock_binding_mismatch',
  'blocked_without_reason_code',
  'blocked_without_pre_block_state',
  'commit_attempt_authorized_not_started',
  'commit_attempt_completed_unrecorded',
  'commit_attempt_evidence_ambiguous',
  'committed_sha_missing',
  'committed_sha_mismatch',
  'committed_sha_not_descendant_of_base',
  'landed_sha_missing',
  'landed_sha_invalid'
] as const
export type ReconcileReasonCode = (typeof RECONCILE_REASON_CODES)[number]

// A single acceptance criterion surfaced from triage output; `covered` is set by
// plan-review / code-audit coverage-matrix bookkeeping in later phases.
export type AuditedAcceptanceCriterion = {
  id: string
  text: string
  /**
   * Whether the latest qualifying plan audit recorded this criterion as covered.
   *
   * `false` means "not recorded as covered", NOT "an audit judged it uncovered" —
   * the two are distinguished by the projection's `coverageAvailable`, never by
   * overloading this flag. Rendering `false` as a judgement when no audit has run
   * would assert an observation nobody made.
   */
  covered: boolean
  /** Sanitized, bounded rationale. Absent when the audit gave none. */
  note?: string
}

export type AuditedPhaseTiming = {
  phase: AuditedPhase
  durationMs: number
  modelCalls: number
  tokens: number | null
}

// The ONLY shape crossing IPC/renderer/notification boundaries for a task.
// Never present here: raw prompts, agent stdout/stderr, diffs, absolute paths,
// command lines, env values, session IDs, full tree OIDs / SHAs, exception text.
export type AuditedTaskStatusProjection = AuditedTaskLandingProjection & {
  taskId: string
  repoId: string
  title: string
  state: AuditedTaskState
  activePhase: AuditedPhase | null
  risk: RiskLevel
  source: AuditedTaskSource
  triageDecision: TriageDecision | null
  triageRunStatus: TriageRunStatus | null
  triageBlockedReasonCode: TriageReasonCode | null
  planRound: number
  fixRound: number
  lastVerdict: ReviewVerdict | null
  // Why: the generic blocked-reason column is shared by every phase that can
  // block a task. A task blocked by a triage failure genuinely persists a
  // TriageReasonCode value here (see finalizeTriageRunInternal / interrupted
  // recovery) — BlockReasonCode alone would misrepresent that runtime value.
  // triageBlockedReasonCode above is the field to prefer for triage-specific
  // UI; this one stays truthful for the generic "Blocked: <code>" fallback.
  blockedReasonCode: BlockReasonCode | TriageReasonCode | null
  approvalState: AuditedApprovalState
  approvalExpiresAt: number | null
  candidateIdShort: string | null
  committedShaShort: string | null
  commitAttemptStatus: CommitAttemptStatus | null
  // Phase 8. The commit lane's failure code, and — kept strictly separate — the
  // advisory recorded on a DURABLE commit. A task may simultaneously be
  // `committed` with a valid committedShaShort AND carry
  // commitAdvisoryCode: 'post_commit_drift_detected'. Rendering that as a failed
  // commit would lie about durable state, so the two never share a field.
  commitReasonCode: CommitReasonCode | null
  commitAdvisoryCode: CommitAdvisoryCode | null
  // Server-computed authorities, exactly like planApprovalReady: the renderer
  // renders these and never derives them, so a renderer bug cannot manufacture
  // an approve or commit affordance.
  commitApprovalReady: boolean
  commitReady: boolean
  // Phase 9 publish lane. The task REMAINS in `committed` throughout: a failed or
  // ambiguous push must never make the local commit look undone, so publishing is
  // tracked here rather than by a task state.
  publishAttemptStatus: PublishAttemptStatus | null
  publishedShaShort: string | null
  publishReasonCode: PublishReasonCode | null
  // ALWAYS a PublishAdvisoryCode, never a PublishReasonCode: once the push is
  // confirmed on the remote, every review-request outcome is advisory-only.
  publishAdvisoryCode: PublishAdvisoryCode | null
  reviewProvider: HostedReviewProvider | null
  reviewNumber: number | null
  reviewAvailable: boolean
  // Server-computed authorities. publishReady and publishRecheckAvailable are
  // MUTUALLY EXCLUSIVE by construction, which is what stops the renderer from
  // ever offering Publish for an outcome that has not been confirmed.
  publishReady: boolean
  publishRecheckAvailable: boolean
  reviewRequestRetryAvailable: boolean
  // Phase 10 local-landing lane. The seven fields are declared as their own
  // composable block in audited-landing-types.ts, so that lane's contract reviews
  // as one unit and this file stays within its max-lines budget.
  reconcileClass: ReconcileClass | null
  reconcileReasonCode: ReconcileReasonCode | null
  // Phase 3: the ONLY worktree facts that cross the boundary. Never a path,
  // branch name, worktree id, provenance id, or common dir.
  worktreeReady: boolean
  worktreeReasonCode: WorktreeReasonCode | null
  // Phase 4: the ONLY execution facts that cross the boundary. Never output
  // content, a log path, argv, a pid, the model, or the prompt.
  executionRunStatus: ExecutionRunStatus | null
  executionReasonCode: ExecutionReasonCode | null
  executionOutputTruncated: boolean
  // Phase 5 plan artifact + Codex plan review. Metadata ONLY — never the plan
  // body, the artifact file path, the content hash, the Codex prompt, argv, or
  // raw review output. The body is fetched on demand through
  // auditedWorkflow:getPlanArtifact, never carried on this projection.
  //
  // planArtifactId is an opaque row id, safe to echo back as a getPlanArtifact
  // argument (the handler re-verifies it belongs to the task).
  planArtifactId: string | null
  planArtifactAvailable: boolean
  planArtifactTruncated: boolean
  planArtifactRedactionCount: number
  planReviewRunStatus: PlanReviewRunStatus | null
  // Same closed union as lastVerdict — there is exactly one verdict vocabulary.
  planReviewVerdict: ReviewVerdict | null
  planReviewReasonCode: PlanReviewReasonCode | null
  // THE ONLY free-text field on this projection, and a deliberate exception to
  // the no-free-text rule: the human approval gate is meaningless without the
  // reviewer's reasoning. It is model-authored, so it passes through the same
  // sanitizePlanText redaction pipeline and is bounded to 4KB BEFORE storage
  // (see audited-plan-review-run-finalize.ts). Never raw model output.
  planReviewSummary: string | null
  planReviewFindingCount: number | null
  // Server-computed authorities. The renderer renders these; it never derives
  // them, so a renderer bug cannot manufacture an approve affordance.
  planApprovalReady: boolean
  planRevisionAvailable: boolean
  // Whether a succeeded plan audit bound to the task's CURRENT artifact exists.
  // Distinguishes "not yet audited" from "audited and found uncovered", which the
  // per-criterion `covered` flag alone cannot express. Server-computed; a false
  // here means the UI must not present any coverage count as a judgement.
  coverageAvailable: boolean
  // Phase 7 code-audit lane. Whether a 'current' candidate exists — the audit
  // affordance is gated on this, never on the tree OID, which never crosses.
  candidateAvailable: boolean
  codeAuditRunStatus: CodeAuditRunStatus | null
  // Same closed union as lastVerdict — there is exactly one verdict vocabulary.
  codeAuditVerdict: ReviewVerdict | null
  codeAuditReasonCode: CodeAuditReasonCode | null
  // HOW the latest audit reached its model. Projected deliberately, unlike most
  // run internals: a `byesu_no_tools` verdict is WEAKER EVIDENCE than a Codex
  // CLI one — no tools, no filesystem, only the bounded bundle Orca sent — and a
  // user reading a verdict must be able to tell which they are looking at.
  // Carries no endpoint, model name, key state, or byte counts.
  codeAuditMode: AuditMode | null
  // Model-authored, sanitized and bounded BEFORE storage — the same treatment as
  // planReviewSummary, and the only free text this lane projects.
  codeAuditSummary: string | null
  codeAuditFindingCount: number | null
  // Server-computed: a fix round is legal from here and the cap is not reached.
  codeFixAvailable: boolean
  acceptanceCriteria: AuditedAcceptanceCriterion[]
  timings: AuditedPhaseTiming[]
  createdAt: number
  updatedAt: number
}

export type AuditedTaskTransitionRecord = {
  seq: number
  fromState: AuditedTaskState | null
  toState: AuditedTaskState
  actor: AuditedTaskActor
  eventType: string
  reasonCode: string | null
  at: number
}

export type RoadmapEntry = {
  id: string
  title: string
  description: string
}

// IPC command contracts (Zod-validated at ipc/audited-workflow.ts) live in
// audited-workflow-command-types.ts, split out to stay under the max-lines
// budget — re-exported here so existing imports from this file keep working.
export * from './audited-workflow-command-types'
// Phase 10's landing vocabularies, split out for the same reason. Re-exported so
// `LandingReasonCode` still resolves from this file, as it has since Phase 1.
export {
  LANDING_REASON_CODES,
  LANDING_ADVISORY_CODES,
  LAND_ATTEMPT_STATUSES,
  LANDING_CLASSIFICATIONS,
  RETRYABLE_LANDING_REASON_CODES,
  isRetryableLandingReasonCode,
  type LandingReasonCode,
  type LandingAdvisoryCode,
  type LandAttemptStatus,
  type LandingClassification
} from './audited-landing-types'
