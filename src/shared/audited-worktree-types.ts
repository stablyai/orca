// Closed vocabularies for Phase 3 audited-worktree provisioning, drift
// verification, and recovery. Separate from audited-workflow-types.ts so the
// triage vocabulary stays closed: widening TriageReasonCode would silently
// break the renderer's exhaustive switch (lint:switch-exhaustiveness).

// Failures only — success is the `ok: true` arm of a discriminated result, never
// a member here. Contention is a command result, never a persisted reason.
export const WORKTREE_REASON_CODES = [
  // provisioning
  'unsupported_host',
  'managed_root_unavailable',
  'managed_root_escapes_workspace',
  'managed_root_inside_source_repo',
  'source_repo_inside_managed_root',
  'branch_already_exists',
  'worktree_path_occupied',
  'base_commit_unresolvable',
  'git_worktree_add_failed',
  'provision_evidence_ambiguous',
  // drift
  'worktree_missing',
  'worktree_path_outside_managed_root',
  'worktree_path_mismatch',
  'repository_identity_mismatch',
  'head_not_symbolic',
  'head_branch_mismatch',
  'head_moved_from_base_commit',
  'branch_tip_moved_from_base_commit',
  'worktree_unreadable',
  // legacy
  'worktree_never_provisioned'
] as const
export type WorktreeReasonCode = (typeof WORKTREE_REASON_CODES)[number]

// `failed` is deliberately split so registry membership is a pure function of
// status (see audited-worktree-registry.ts). failed_no_effect: Git provably did
// nothing. failed_ambiguous: partial/mismatched evidence remains and must stay
// guarded. There is no bare `failed`.
export const WORKTREE_ATTEMPT_STATUSES = [
  'claimed',
  'created',
  'verified',
  'finalized',
  'failed_ambiguous',
  'failed_no_effect',
  'abandoned'
] as const
export type WorktreeAttemptStatus = (typeof WORKTREE_ATTEMPT_STATUSES)[number]

// The single source of truth for "which attempt statuses contribute an intended
// path to the guard registry". The startup rebuild query and the in-memory
// publication rule both derive from this, so a released path can never be
// resurrected by a restart.
export const REGISTRY_GUARDED_ATTEMPT_STATUSES = [
  'claimed',
  'created',
  'verified',
  'finalized',
  'failed_ambiguous'
] as const
export type RegistryGuardedAttemptStatus = (typeof REGISTRY_GUARDED_ATTEMPT_STATUSES)[number]

export const REGISTRY_RELEASED_ATTEMPT_STATUSES = ['failed_no_effect', 'abandoned'] as const

// Provenance describes an ACTUALLY VERIFIED worktree, never migration history —
// a task with no worktree keeps worktree_provenance NULL.
export const WORKTREE_PROVENANCE_KINDS = ['orca_audited_v1'] as const
export type WorktreeProvenanceKind = (typeof WORKTREE_PROVENANCE_KINDS)[number]

// Provisioning failures that MAY be retryable — a necessary but NOT sufficient
// condition. The main process additionally requires durable attempt state
// proving Git made no lasting change (audited-worktree-recovery.ts); this list
// only decides whether the renderer draws a Retry affordance at all.
//
// `worktree_unreadable` is deliberately absent: it can arise from post-add drift
// verification, where `git worktree add` already SUCCEEDED and the attempt is
// failed_ambiguous with its path still guarded. Offering a retry there would
// invite a fresh claim against real, unexplained Git state.
export const RETRYABLE_PROVISIONING_REASON_CODES: readonly WorktreeReasonCode[] = [
  'git_worktree_add_failed',
  'managed_root_unavailable',
  'base_commit_unresolvable'
]

export function isRetryableProvisioningReasonCode(code: WorktreeReasonCode): boolean {
  return RETRYABLE_PROVISIONING_REASON_CODES.includes(code)
}
