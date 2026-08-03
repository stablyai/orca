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
  'nextStepPrompt'
] as const
