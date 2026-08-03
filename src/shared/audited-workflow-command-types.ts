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

export type AuditedWorkflowProvisionWorktreeParams = { taskId: string }
export type AuditedWorkflowProvisionWorktreeResult = AuditedCommandResult

export type AuditedWorkflowVerifyWorktreeParams = { taskId: string }
export type AuditedWorkflowVerifyWorktreeResult = AuditedCommandResult

// Triage-provider credential status/management. `configured` is the ONLY
// fact ever exposed here — never the key itself, a masked form, encrypted
// bytes, or a filesystem path. See audited-triage-api-key-store.ts.
export type AuditedWorkflowTriageProviderStatus = { configured: boolean }
export type AuditedWorkflowSaveTriageApiKeyParams = { apiKey: string }

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
