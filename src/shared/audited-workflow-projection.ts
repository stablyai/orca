// Builds the sanitized AuditedTaskStatusProjection from internal task state.
// This is the ONLY function that may produce the shape crossing IPC/renderer/
// notification boundaries — see audited-workflow-types.ts for the forbidden-field
// list. Keep this file free of any import that could tempt it to reach for a raw
// path, prompt, or log.

import type {
  AuditedApprovalState,
  AuditedTaskState,
  AuditedTaskSource,
  AuditedTaskStatusProjection,
  BlockReasonCode,
  CommitAttemptStatus,
  ReconcileClass,
  ReconcileReasonCode,
  ReviewVerdict,
  RiskLevel,
  TriageDecision,
  TriageReasonCode,
  TriageRunStatus,
  AuditedAcceptanceCriterion,
  AuditedPhaseTiming
} from './audited-workflow-types'
import type { WorktreeReasonCode } from './audited-worktree-types'
import type { ExecutionReasonCode, ExecutionRunStatus } from './audited-execution-types'
import { MAX_PLAN_ROUNDS } from './audited-plan-artifact-types'
import type { PlanReviewReasonCode, PlanReviewRunStatus } from './audited-plan-artifact-types'

// Truncates a full identity value (tree OID / SHA) to a short, non-authorizing
// display form. Never accepted back as input anywhere — see plan §5.
export function shortenCandidateId(fullValue: string | null): string | null {
  if (!fullValue) {
    return null
  }
  return fullValue.slice(0, 12)
}

export type ProjectionSourceTask = {
  taskId: string
  repoId: string
  title: string
  state: AuditedTaskState
  activePhase: string | null
  risk: RiskLevel
  source: AuditedTaskSource
  triageDecision: TriageDecision | null
  triageRunStatus: TriageRunStatus | null
  triageBlockedReasonCode: TriageReasonCode | null
  planRound: number
  fixRound: number
  lastVerdict: ReviewVerdict | null
  blockedReasonCode: BlockReasonCode | TriageReasonCode | null
  approvalState: AuditedApprovalState
  approvalExpiresAt: number | null
  auditApprovedTreeOid: string | null
  committedSha: string | null
  commitAttemptStatus: CommitAttemptStatus | null
  reconcileClass: ReconcileClass | null
  reconcileReasonCode: ReconcileReasonCode | null
  // Phase 3 worktree state. Only the sanitized readiness boolean and the closed
  // reason code are projected — never the path, branch, worktree id, provenance,
  // or common dir.
  worktreeProvenance: string | null
  worktreeVerifiedAt: number | null
  worktreeReasonCode: WorktreeReasonCode | null
  // Phase 4 execution state. Three fields only — never output content, a log
  // path, argv, a pid, the model, or the prompt.
  executionRunStatus: ExecutionRunStatus | null
  executionReasonCode: ExecutionReasonCode | null
  executionOutputTruncated: boolean
  // Phase 5. The source carries the artifact's content hash and the task's
  // plan_round so this builder can compute the two server-side authorities;
  // NEITHER the hash nor any path is copied onto the projection.
  planArtifactId: string | null
  planArtifactStatus: string | null
  planArtifactTruncated: boolean
  planArtifactRedactionCount: number
  planReviewRunStatus: PlanReviewRunStatus | null
  planReviewVerdict: ReviewVerdict | null
  planReviewReasonCode: PlanReviewReasonCode | null
  planReviewSummary: string | null
  planReviewFindingCount: number | null
  // True only when a SUCCEEDED review run carries verdict 'approved' AND is
  // bound to the task's current artifact by both id and hash. Computed by the
  // repository inside its read, not re-derived here.
  planReviewApprovedForCurrentArtifact: boolean
  acceptanceCriteria: AuditedAcceptanceCriterion[]
  timings: AuditedPhaseTiming[]
  createdAt: number
  updatedAt: number
}

export function buildAuditedTaskProjection(
  source: ProjectionSourceTask
): AuditedTaskStatusProjection {
  return {
    taskId: source.taskId,
    repoId: source.repoId,
    title: source.title,
    state: source.state,
    activePhase: source.activePhase as AuditedTaskStatusProjection['activePhase'],
    risk: source.risk,
    source: source.source,
    triageDecision: source.triageDecision,
    triageRunStatus: source.triageRunStatus,
    triageBlockedReasonCode: source.triageBlockedReasonCode,
    planRound: source.planRound,
    fixRound: source.fixRound,
    lastVerdict: source.lastVerdict,
    blockedReasonCode: source.blockedReasonCode,
    approvalState: source.approvalState,
    approvalExpiresAt: source.approvalExpiresAt,
    candidateIdShort: shortenCandidateId(source.auditApprovedTreeOid),
    committedShaShort: shortenCandidateId(source.committedSha),
    commitAttemptStatus: source.commitAttemptStatus,
    reconcileClass: source.reconcileClass,
    reconcileReasonCode: source.reconcileReasonCode,
    // Ready requires ALL THREE: provenance (a worktree was finalized), a
    // verification timestamp (it was actually verified), and no recorded
    // failure. Provenance alone is insufficient — a task can carry provenance
    // from an earlier finalization while a later verification has not run.
    worktreeReady:
      Boolean(source.worktreeProvenance) &&
      source.worktreeVerifiedAt !== null &&
      source.worktreeReasonCode === null,
    worktreeReasonCode: source.worktreeReasonCode,
    executionRunStatus: source.executionRunStatus,
    executionReasonCode: source.executionReasonCode,
    executionOutputTruncated: source.executionOutputTruncated,
    planArtifactId: source.planArtifactId,
    // Available requires BOTH an id and 'current' status: a superseded artifact
    // is still readable by id (history), but it is not the plan under review.
    planArtifactAvailable:
      source.planArtifactId !== null && source.planArtifactStatus === 'current',
    planArtifactTruncated: source.planArtifactTruncated,
    planArtifactRedactionCount: source.planArtifactRedactionCount,
    planReviewRunStatus: source.planReviewRunStatus,
    planReviewVerdict: source.planReviewVerdict,
    planReviewReasonCode: source.planReviewReasonCode,
    planReviewSummary: source.planReviewSummary,
    planReviewFindingCount: source.planReviewFindingCount,
    // Approve is offered ONLY for a task resting in awaiting_plan_review whose
    // CURRENT artifact carries a durable 'approved' verdict. Deliberately not a
    // function of planRound — a round-3 plan stays approvable.
    planApprovalReady:
      source.state === 'awaiting_plan_review' &&
      source.planArtifactId !== null &&
      source.planArtifactStatus === 'current' &&
      source.planReviewApprovedForCurrentArtifact,
    // Revision is offered only from plan_fixes_requested and only below the
    // round cap — the cap binds when STARTING a revision, nowhere else.
    planRevisionAvailable:
      source.state === 'plan_fixes_requested' && source.planRound < MAX_PLAN_ROUNDS,
    acceptanceCriteria: source.acceptanceCriteria,
    timings: source.timings,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  }
}

// Fields that must NEVER appear on the projection. Used by a denylist test
// (see audited-workflow-projection.test.ts) that inspects the runtime object,
// not just the compiled type, since a bug could still attach an extra field.
export const AUDITED_PROJECTION_FORBIDDEN_KEYS = [
  'prompt',
  'stdout',
  'stderr',
  'diff',
  'path',
  'worktreePath',
  'sourceRepoPath',
  'commandLine',
  'env',
  'sessionId',
  'baseCommit',
  'expectedTreeOid',
  'committedSha', // full form; only committedShaShort is allowed
  'auditApprovedTreeOid',
  'exception',
  'stack',
  // Phase 3 worktree identity — only worktreeReady/worktreeReasonCode may cross.
  'branchName',
  'worktreeId',
  'worktreeProvenanceId',
  'sourceRepoCommonDir',
  'intendedPath',
  'intendedBranch',
  // Phase 4 execution internals — only the three execution* fields may cross.
  // Agent output is the highest-risk field for embedded secrets and absolute
  // paths, so not even a path to the log directory is projected.
  'executionLogPath',
  'stdoutLog',
  'stderrLog',
  'argv',
  'settingsPath',
  'pid',
  'model',
  'nextStepPrompt',
  // Phase 5 plan-artifact / Codex-review internals. Only the metadata fields
  // and the bounded, sanitized planReviewSummary may cross. The plan BODY is
  // fetched on demand and is never attached to a projection; not even the
  // artifact's content hash crosses, since it is an authorization input.
  'planText',
  'planBody',
  'planArtifactPath',
  'artifactPath',
  'planArtifactSha256',
  'contentSha256',
  'codexArgv',
  'codexPrompt',
  'auditPrompt',
  'lastMessagePath',
  'reviewStdout',
  'reviewStderr'
] as const
