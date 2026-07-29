// Closed vocabularies and sanitized contracts for the Audited Workflow feature.
// No free text crosses any IPC/renderer/notification boundary through these types —
// see docs/audited-workflow.md for the trust-boundary rationale.

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

export const COMMIT_ATTEMPT_STATUSES = ['authorized', 'completed', 'failed', 'abandoned'] as const
export type CommitAttemptStatus = (typeof COMMIT_ATTEMPT_STATUSES)[number]

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
  'lock_contended'
] as const
export type LandingReasonCode = (typeof LANDING_REASON_CODES)[number]

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
  covered: boolean
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
export type AuditedTaskStatusProjection = {
  taskId: string
  repoId: string
  title: string
  state: AuditedTaskState
  activePhase: AuditedPhase | null
  risk: RiskLevel
  source: AuditedTaskSource
  triageDecision: TriageDecision | null
  triageReasonCode: BlockReasonCode | null
  planRound: number
  fixRound: number
  lastVerdict: ReviewVerdict | null
  blockedReasonCode: BlockReasonCode | null
  approvalState: AuditedApprovalState
  approvalExpiresAt: number | null
  candidateIdShort: string | null
  committedShaShort: string | null
  commitAttemptStatus: CommitAttemptStatus | null
  reconcileClass: ReconcileClass | null
  reconcileReasonCode: ReconcileReasonCode | null
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

// ---------------------------------------------------------------------------
// Command contracts (Zod-validated at the IPC boundary; see ipc/audited-workflow.ts)
// ---------------------------------------------------------------------------

export type AuditedWorkflowListTasksParams = { repoId?: string }
export type AuditedWorkflowGetTaskParams = { taskId: string }
export type AuditedWorkflowListRoadmapParams = { repoId: string }
export type AuditedWorkflowSelectTaskParams = {
  repoId: string
  source: AuditedTaskSource
  roadmapId?: string
  title: string
  description: string
  risk: RiskLevel
}

// Closed reason codes for task-selection failures. Every expected failure
// mode (repo not found, SSH/folder repo rejection, Git resolution failure,
// unexpected internal error) maps to exactly one of these — never a raw
// exception message, path, command string, or Git stderr. See plan §10.2
// privacy boundaries and the IPC error-redaction requirement.
export const SELECT_TASK_REASON_CODES = [
  'repo_not_found',
  'unsupported_host',
  'git_resolution_failed',
  'internal_error'
] as const
export type SelectTaskReasonCode = (typeof SELECT_TASK_REASON_CODES)[number]

export type AuditedWorkflowSelectTaskResult =
  | { ok: true; taskId: string }
  | { ok: false; reasonCode: SelectTaskReasonCode }

export type AuditedWorkflowRunPhaseParams = { taskId: string; phase: AuditedPhase }
export type AuditedWorkflowCommandResult = { accepted: boolean; reasonCode?: string }

export type AuditedWorkflowApproveParams = {
  taskId: string
  approver: string
  ttlPreset: ApprovalTtlPreset
}
export type AuditedWorkflowApproveResult = { granted: boolean; reasonCode: ApprovalReasonCode }

export type AuditedWorkflowRevokeApprovalParams = { taskId: string }
export type AuditedWorkflowRevokeApprovalResult = {
  revoked: boolean
  reasonCode: ApprovalReasonCode
}

export type AuditedWorkflowCommitParams = { taskId: string; message: string }
export type AuditedWorkflowCommitResult = { committed: boolean; reasonCode: string }

export type AuditedWorkflowResumeAttemptParams = { taskId: string }
export type AuditedWorkflowResumeAttemptResult = { resumed: boolean; reasonCode: string }

export type AuditedWorkflowFinalizeAttemptParams = { taskId: string }
export type AuditedWorkflowFinalizeAttemptResult = { finalized: boolean; reasonCode: string }

export type AuditedWorkflowLandParams = { taskId: string }
export type AuditedWorkflowLandResult = { landed: boolean; reasonCode: LandingReasonCode }

export type AuditedWorkflowCancelParams = { taskId: string }
export type AuditedWorkflowRetryParams = { taskId: string }
export type AuditedWorkflowGenericResult = { ok: boolean; reasonCode?: string }

export type AuditedWorkflowReconcileParams = { taskId?: string }
export type AuditedWorkflowReconcileResult = {
  taskId: string
  classification: ReconcileClass
  reasonCode: ReconcileReasonCode
}

export type AuditedWorkflowOpenArtifactParams = {
  taskId: string
  artifactKind: string
  round?: number
}
export type AuditedWorkflowOpenArtifactResult = { opened: boolean }

// Phase-1-only, dev-build-gated manual transition control. Never present in a
// packaged build — see ipc/audited-workflow-dev-transitions.ts.
// `command` names one of the AuditedTransitionCommand values from
// audited-workflow-state-machine.ts. That type isn't re-exported from shared
// (it's a main-process-only module), so it's typed as a plain string here
// and validated by the Zod enum in ipc/audited-workflow-dev-transitions.ts.
export type AuditedWorkflowDevTransitionParams = {
  taskId: string
  command: string
}
export type AuditedWorkflowDevTransitionResult = { applied: boolean; reasonCode?: string }
