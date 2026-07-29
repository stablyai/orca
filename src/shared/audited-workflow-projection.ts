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
  AuditedAcceptanceCriterion,
  AuditedPhaseTiming
} from './audited-workflow-types'

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
  triageReasonCode: BlockReasonCode | null
  planRound: number
  fixRound: number
  lastVerdict: ReviewVerdict | null
  blockedReasonCode: BlockReasonCode | null
  approvalState: AuditedApprovalState
  approvalExpiresAt: number | null
  auditApprovedTreeOid: string | null
  committedSha: string | null
  commitAttemptStatus: CommitAttemptStatus | null
  reconcileClass: ReconcileClass | null
  reconcileReasonCode: ReconcileReasonCode | null
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
    triageReasonCode: source.triageReasonCode,
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
  'stack'
] as const
