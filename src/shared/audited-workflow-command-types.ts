// IPC command contracts for Audited Workflow (Zod-validated at the boundary;
// see ipc/audited-workflow.ts). Split from audited-workflow-types.ts to stay
// under the max-lines budget without a suppression — that file owns the
// closed vocabularies and domain/projection types this one builds requests
// and results from.
import type {
  ApprovalReasonCode,
  ApprovalTtlPreset,
  AuditedPhase,
  AuditedTaskSource,
  LandingReasonCode,
  ReconcileClass,
  ReconcileReasonCode,
  RiskLevel,
  TriageReasonCode
} from './audited-workflow-types'
import type { WorktreeReasonCode } from './audited-worktree-types'
import type { ExecutionReasonCode } from './audited-execution-types'
import type {
  PlanApprovalReasonCode,
  PlanArtifactStatus,
  PlanReviewReasonCode,
  PlanRevisionReasonCode
} from './audited-plan-artifact-types'
import type { CodeAuditReasonCode } from './audited-code-audit-types'
import type { CommitReasonCode } from './audited-commit-types'

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

// One discriminated result for every audited command. `reasonCode` is always the
// property name; `kind` selects its vocabulary. Never two alternative property
// names on the same result.
export type AuditedCommandResult =
  | { ok: true }
  | { ok: false; kind: 'triage'; reasonCode: TriageReasonCode }
  | { ok: false; kind: 'worktree'; reasonCode: WorktreeReasonCode }
  // Contention is a command outcome only — it is never persisted as a blocked
  // reason and has no reason code.
  | { ok: false; kind: 'contended' }

export type AuditedWorkflowStartTriageParams = { taskId: string }
export type AuditedWorkflowStartTriageResult = AuditedCommandResult

export type AuditedWorkflowRetryTriageParams = { taskId: string }
export type AuditedWorkflowRetryTriageResult = AuditedCommandResult

// Phase 4 execution commands. The `worktree` arm carries an explicit `persisted`
// discriminator because the two execution entry points fail in genuinely
// different ways, and conflating them would make the renderer lie:
//
//  - `persisted: true` — startExecution's ensureWorktreeForTask failure. That
//    function BLOCKED the task and wrote worktree_reason_code, so the reason IS
//    a durable column the projection already carries. The renderer's existing
//    persisted-reason block renders it, and worktree recovery may be admissible
//    for it (audited-worktree-recovery.ts decides).
//
//  - `persisted: false` — retryExecution's verifyWorktreeForTask preflight
//    failure. Read-only: nothing was written, the task keeps its existing
//    execution block, and worktree_reason_code stays null. Display-only and NOT
//    admissible to worktree recovery; the sole action it may lead to is Retry.
// The two worktree arms are spelled out as LITERAL types rather than
// `persisted: boolean` so `persisted` is a real discriminant: narrowing on it
// selects one arm, and a consumer that forgets to branch on it is a type error
// rather than a silently-wrong render.
export type ExecutionCommandResult =
  | { ok: true }
  | { ok: false; kind: 'execution'; reasonCode: ExecutionReasonCode }
  | { ok: false; kind: 'worktree'; reasonCode: WorktreeReasonCode; persisted: true }
  | { ok: false; kind: 'worktree'; reasonCode: WorktreeReasonCode; persisted: false }

export type AuditedWorkflowStartExecutionParams = { taskId: string }
export type AuditedWorkflowStartExecutionResult = ExecutionCommandResult
export type AuditedWorkflowCancelExecutionParams = { taskId: string }
export type AuditedWorkflowCancelExecutionResult = ExecutionCommandResult
export type AuditedWorkflowRetryExecutionParams = { taskId: string }
export type AuditedWorkflowRetryExecutionResult = ExecutionCommandResult

// Phase 5 plan-review commands. Like the execution commands, the ONLY renderer
// input is a taskId (plus an opaque artifactId for the read, which the handler
// re-verifies belongs to that task). Prompt, model, argv, cwd, output path, and
// config are all main-derived.
export type PlanReviewCommandResult =
  | { ok: true }
  | { ok: false; kind: 'planReview'; reasonCode: PlanReviewReasonCode }
  // A read-only worktree verification failure. Nothing was written and nothing
  // spawned; display-only, exactly like retryExecution's fresh preflight arm.
  | { ok: false; kind: 'worktree'; reasonCode: WorktreeReasonCode }

export type AuditedWorkflowStartPlanAuditParams = { taskId: string }
export type AuditedWorkflowStartPlanAuditResult = PlanReviewCommandResult
export type AuditedWorkflowCancelPlanAuditParams = { taskId: string }
export type AuditedWorkflowCancelPlanAuditResult = PlanReviewCommandResult
export type AuditedWorkflowRetryPlanAuditParams = { taskId: string }
export type AuditedWorkflowRetryPlanAuditResult = PlanReviewCommandResult

export type AuditedWorkflowApprovePlanParams = { taskId: string }
export type AuditedWorkflowApprovePlanResult =
  | { ok: true }
  | { ok: false; reasonCode: PlanApprovalReasonCode }

export type AuditedWorkflowRequestPlanRevisionParams = { taskId: string }
export type AuditedWorkflowRequestPlanRevisionResult =
  | { ok: true }
  | { ok: false; reasonCode: PlanRevisionReasonCode }

// The plan BODY, fetched on demand. Deliberately NOT on the task projection:
// it is the largest and highest-risk field in the feature, so it crosses only
// when a human explicitly opens it, and only for the task that owns it.
export type AuditedWorkflowGetPlanArtifactParams = { taskId: string; artifactId: string }
export type AuditedWorkflowGetPlanArtifactResult =
  | {
      ok: true
      text: string
      truncated: boolean
      redactionCount: number
      round: number
      status: PlanArtifactStatus
    }
  | { ok: false; reasonCode: 'artifact_unavailable' }

export type AuditedWorkflowProvisionWorktreeParams = { taskId: string }
export type AuditedWorkflowProvisionWorktreeResult = AuditedCommandResult

export type AuditedWorkflowVerifyWorktreeParams = { taskId: string }
export type AuditedWorkflowVerifyWorktreeResult = AuditedCommandResult

// Triage-provider credential status/management. `configured` is the ONLY
// fact ever exposed here — never the key itself, a masked form, encrypted
// bytes, or a filesystem path. See audited-triage-api-key-store.ts.
export type AuditedWorkflowTriageProviderStatus = { configured: boolean }
export type AuditedWorkflowSaveTriageApiKeyParams = { apiKey: string }

// Audited Codex provider key. `{ apiKey }` and nothing else — the renderer never
// names a provider, an endpoint, or an env var; main derives the selection from
// its code-owned registry.
export type AuditedWorkflowSaveCodexProviderKeyParams = { apiKey: string }

// Phase 8. `approver` is deliberately ABSENT: like every Phase 3-7 command, the
// renderer supplies only a taskId (plus a server-side TTL preset name, never a
// raw duration). A renderer-supplied approver string would be unverifiable, so
// main derives the approval's authority entirely from durable state.
export type AuditedWorkflowApproveParams = {
  taskId: string
  ttlPreset: ApprovalTtlPreset
}

// The house discriminated union, replacing the Phase-1 `{ granted, reasonCode }`
// shape: `reasonCode` is always the property name and `kind` selects its
// vocabulary. See the contract note above ExecutionCommandResult.
export type ApprovalCommandResult =
  | { ok: true }
  | { ok: false; kind: 'approval'; reasonCode: ApprovalReasonCode }

export type AuditedWorkflowApproveResult = ApprovalCommandResult

export type AuditedWorkflowRevokeApprovalParams = { taskId: string }
export type AuditedWorkflowRevokeApprovalResult = ApprovalCommandResult

// The commit message is renderer-authored INPUT. It travels main-ward only and is
// never echoed back on the projection or logged.
export type AuditedWorkflowCommitParams = { taskId: string; message: string }
export type CommitCommandResult =
  | { ok: true }
  | { ok: false; kind: 'commit'; reasonCode: CommitReasonCode }
  // A read-only worktree verification failure. Nothing was written and nothing
  // spawned; display-only, exactly like the plan-review lane's worktree arm.
  | { ok: false; kind: 'worktree'; reasonCode: WorktreeReasonCode }
export type AuditedWorkflowCommitResult = CommitCommandResult

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

// Phase 7 code-audit lane. One params/result pair for all four commands: each
// takes only a taskId, and each fails with the same two closed vocabularies.
export type AuditedWorkflowCodeAuditParams = { taskId: string }
export type AuditedWorkflowCodeAuditResult =
  | { ok: true }
  | { ok: false; kind: 'codeAudit'; reasonCode: CodeAuditReasonCode }
  // The closed worktree vocabulary, not a bare string: the renderer narrows on
  // `kind` and hands this to getWorktreeErrorMessage, whose exhaustive switch is
  // what keeps a widened union from silently falling through.
  | { ok: false; kind: 'worktree'; reasonCode: WorktreeReasonCode }

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
