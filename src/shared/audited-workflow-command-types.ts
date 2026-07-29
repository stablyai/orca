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

export type AuditedWorkflowStartTriageParams = { taskId: string }
export type AuditedWorkflowStartTriageResult =
  | { ok: true }
  | { ok: false; reasonCode: TriageReasonCode }

export type AuditedWorkflowRetryTriageParams = { taskId: string }
export type AuditedWorkflowRetryTriageResult =
  | { ok: true }
  | { ok: false; reasonCode: TriageReasonCode }

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
