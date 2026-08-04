// Closed vocabularies for Phase 5 plan artifacts and Codex plan-review runs.
// Separate from audited-workflow-types.ts for the same reason
// audited-execution-types.ts is: widening a union here must break the renderer's
// exhaustive switches (lint:switch-exhaustiveness) rather than fall through.
//
// DELIBERATELY ABSENT: a verdict vocabulary. Codex plan verdicts use the
// EXISTING ReviewVerdict ('approved' | 'fixes_requested' | 'blocked') from
// audited-workflow-types.ts. A second semantically-identical union would have to
// be bridged at the last_verdict write site by a cast or a lossy mapping table —
// see the plan §1.
import type { ReviewVerdict } from './audited-workflow-types'

export const PLAN_ARTIFACT_STATUSES = ['current', 'superseded'] as const
export type PlanArtifactStatus = (typeof PLAN_ARTIFACT_STATUSES)[number]

// `running` is the only non-terminal status, mirroring ExecutionRunStatus.
export const PLAN_REVIEW_RUN_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted'
] as const
export type PlanReviewRunStatus = (typeof PLAN_REVIEW_RUN_STATUSES)[number]

// Failures only — success is the `ok: true` arm of a discriminated result.
export const PLAN_REVIEW_REASON_CODES = [
  'illegal_transition',
  'lock_contended',
  'worktree_not_verified',
  'artifact_unavailable',
  // The run's artifact is no longer the task's current one (or its hash moved).
  // Set both at admission (nothing spawned) and at finalization (verdict discarded).
  'artifact_superseded',
  // The task moved out of awaiting_plan_review while this run was in flight.
  'task_state_changed',
  // The durable triage run carries no usable acceptance criteria. Auditing a
  // plan against nothing would let Codex approve work that satisfies no stated
  // requirement, so the audit refuses to start instead.
  'acceptance_criteria_unavailable',
  // The task's worktree identity changed between the pre-verification read and
  // the launch. Refusing is the only safe response: spawning would use a cwd
  // that is no longer the verified worktree.
  'worktree_identity_changed',
  // A custom Codex provider is selected but its key is missing or unreadable.
  'provider_not_configured',
  // A persisted provider selection is unusable (unknown id, blank model, corrupt
  // shape). RESERVED: unreachable from the resolver while selection is derived
  // from the key store alone — it becomes reachable with the future picker.
  // Still produced by the argv layer, which validates provider definitions.
  'provider_settings_invalid',
  // A provider AND its key are configured, and Orca is deliberately declining to
  // deliver the secret because the credential-delivery capability is disabled.
  // Distinct from provider_not_configured: the user configured something real,
  // and telling them to "configure a key" would be a lie about their own state.
  'credential_delivery_unavailable',
  // The opaque key-existence probe itself failed — an unreadable ~/.orca, a
  // permission error, an unresolvable home path. Orca cannot tell whether a
  // provider is configured, so it refuses rather than guessing.
  //
  // Distinct from the two above, and deliberately so: reporting "not configured"
  // would assert an absence we did not observe, and reporting
  // "delivery unavailable" would assert a presence we did not observe either.
  // The only truthful statement is that the question could not be answered.
  // RETRYABLE — unlike the other provider codes, this is an environmental
  // condition that can clear on its own.
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
export type PlanReviewReasonCode = (typeof PLAN_REVIEW_REASON_CODES)[number]

// Server-side authority for whether Retry Audit is admissible.
//
// Deliberately absent: `verdict_unparseable` (a rerun against the same plan
// reproduces it), `output_too_large` (same flood), `artifact_superseded` and
// `task_state_changed` (not failures of this run — the task moved on),
// `cancelled_by_user` (not a failure), `unexpected_commit_detected` (drift the
// audit cannot undo), and the admission codes, none of which reached a spawn.
export const RETRYABLE_PLAN_REVIEW_REASON_CODES: readonly PlanReviewReasonCode[] = [
  'exit_nonzero',
  'timeout',
  'interrupted',
  'spawn_failed',
  'codex_not_found',
  'empty_output',
  // A transient admission race: the identity moved while the audit was
  // starting, nothing ran, and the next attempt sees the settled row. Unlike
  // acceptance_criteria_unavailable, which needs triage re-run and is therefore
  // deliberately absent.
  'worktree_identity_changed',
  // An environmental probe failure (unreadable ~/.orca, permission error). Unlike
  // the other provider codes this CAN clear on its own, so Retry is a real
  // action rather than a promise that must fail.
  'provider_storage_unavailable'
  // Deliberately absent: provider_not_configured, provider_settings_invalid, and
  // credential_delivery_unavailable. None is fixed by retrying — two need
  // configuration and one needs a reviewed code change — so offering Retry would
  // promise an action that must fail.
]

export function isRetryablePlanReviewReasonCode(code: PlanReviewReasonCode): boolean {
  return RETRYABLE_PLAN_REVIEW_REASON_CODES.includes(code)
}

// `no_approved_verdict` names the ReviewVerdict value it checks for; there is no
// 'accepted' anywhere in this feature.
export const PLAN_APPROVAL_REASON_CODES = [
  'illegal_transition',
  'lock_contended',
  'no_approved_verdict',
  'artifact_superseded',
  'artifact_unavailable'
] as const
export type PlanApprovalReasonCode = (typeof PLAN_APPROVAL_REASON_CODES)[number]

export const PLAN_REVISION_REASON_CODES = [
  'illegal_transition',
  'lock_contended',
  'round_limit_reached',
  'worktree_not_verified',
  'prompt_unavailable'
] as const
export type PlanRevisionReasonCode = (typeof PLAN_REVISION_REASON_CODES)[number]

// Launch-plan CONSTRUCTION failures. buildCodexPlanAuditPlan returns one of
// these rather than emitting a weaker argv: a missing approval-policy override
// or an enabled user config silently restores write capability (see
// audited-codex-launch-plan.ts), so the only safe response is to refuse to launch.
// NOTE: `provider_settings_invalid` intentionally appears in BOTH this union and
// PLAN_REVIEW_REASON_CODES. They are distinct types reached by distinct paths —
// argv construction versus pre-admission refusal — and neither is cast to the
// other. The only sanctioned crossing is the existing `launch_plan_invalid`
// plan-review code, which reports "argv could not be built safely".
export const LAUNCH_PLAN_REASON_CODES = [
  'required_flag_missing',
  'unsafe_sandbox_mode',
  'unsafe_approval_policy',
  'user_config_not_ignored',
  'forbidden_flag_present',
  'invalid_launch_path',
  // A provider definition is unusable: unregistered codexProviderId, mismatched
  // override segment, bad wire_api, or a duplicate declaration.
  'provider_settings_invalid',
  // A `base_url` that is not the registry value for its codexProviderId. The
  // endpoint-binding check: even if every other layer were bypassed, a foreign
  // endpoint is refused before spawn.
  'provider_endpoint_not_allowed',
  // `env_key` is present with a value other than AUDITED_CODEX_ENV_KEY.
  'env_key_mismatch',
  // `requires_openai_auth` present for any provider. Probe C showed it leaves the
  // injected variable unrequired, so an argv carrying it has an ambiguous
  // credential source.
  'requires_openai_auth_forbidden'
] as const
export type LaunchPlanReasonCode = (typeof LAUNCH_PLAN_REASON_CODES)[number]

// Matches the existing CHECK(plan_round BETWEEN 0 AND 3) on audited_tasks.
// planRound 0 = the original plan; 1..3 = completed revision rounds. Enforced
// when STARTING a revision, never when auditing or approving — a round-3 plan
// must still be auditable and approvable.
export const MAX_PLAN_ROUNDS = 3

// The verdict a Codex plan review produced. Re-exported as a named alias so
// call sites read intently without inventing a parallel union.
export type PlanReviewVerdict = ReviewVerdict

// Phase 6. Bounds the model-authored coverage note AFTER redaction, so a
// pathological one-sentence-please response cannot be persisted as a large blob
// or pushed through the projection. Deliberately far below the 4KB summary cap:
// a note annotates ONE criterion in a checklist row.
export const MAX_COVERAGE_NOTE_CHARS = 200

// Phase 6. One criterion's judgement from one plan-audit run, already reconciled
// against the authoritative triage criteria and sanitized. This is the shape
// written to audited_plan_coverage — never a raw model entry.
export type CoverageRow = {
  criterionId: string
  covered: boolean
  /** Null when the model gave no note, or gave one that sanitized to nothing. */
  note: string | null
}
