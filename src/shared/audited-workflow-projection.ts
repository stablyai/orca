// Builds the sanitized AuditedTaskStatusProjection from internal task state.
// This is the ONLY function that may produce the shape crossing IPC/renderer/
// notification boundaries — see audited-workflow-types.ts for the forbidden-field
// list. Keep this file free of any import that could tempt it to reach for a raw
// path, prompt, or log.

import type { AuditMode } from './audited-audit-mode-types'
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
import type { CodeAuditReasonCode, CodeAuditRunStatus } from './audited-code-audit-types'
import type { CommitAdvisoryCode, CommitReasonCode } from './audited-commit-types'
import {
  canRetryReviewRequest,
  type PublishAdvisoryCode,
  type PublishReasonCode
} from './audited-publish-types'
import type { LandingReasonCode, PublishAttemptStatus } from './audited-workflow-types'
import {
  isRetryableLandingReasonCode,
  type LandAttemptStatus,
  type LandingAdvisoryCode
} from './audited-landing-types'
import type { HostedReviewProvider } from './hosted-review'
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
  // Phase 8. The commit lane's failure code and, kept separate, the advisory that
  // can only accompany a DURABLE commit.
  commitReasonCode: CommitReasonCode | null
  commitAdvisoryCode: CommitAdvisoryCode | null
  // Phase 9 publish lane. publishedSha is the FULL sha and is shortened here; it
  // never crosses in full, exactly like committedSha.
  publishAttemptStatus: PublishAttemptStatus | null
  publishedSha: string | null
  publishReasonCode: PublishReasonCode | null
  publishAdvisoryCode: PublishAdvisoryCode | null
  reviewProvider: HostedReviewProvider | null
  reviewNumber: number | null
  // True only when the task's LATEST commit attempt is `completed` AND its
  // created_commit_sha equals committed_sha. Resolved by the repository in the
  // same query authorizePublishAttempt uses, so what the UI offers and what the
  // transaction permits cannot diverge.
  commitAttemptPublishable: boolean
  // Phase 10 landing lane. landedSha is the FULL sha and is shortened here; it
  // never crosses in full, exactly like committedSha and publishedSha.
  landAttemptStatus: LandAttemptStatus | null
  landedSha: string | null
  landingReasonCode: LandingReasonCode | null
  landingAdvisoryCode: LandingAdvisoryCode | null
  // THE PHASE 9 PUBLICATION GATE, resolved by the repository in the SAME query
  // authorizeLandAttempt uses, so what the UI offers and what the transaction
  // permits cannot diverge. True only when the task's LATEST publish attempt is
  // `completed` AND both its intended_sha and pushed_sha equal committed_sha.
  publishAttemptLandable: boolean
  // Whether the host can land at all. WSL/SSH landing is out of scope, so a
  // non-local task must never be offered the affordance.
  landHostSupported: boolean
  // True only when the task's CURRENT candidate is the one the code audit
  // approved, by both id and tree OID. Resolved by the repository in the same
  // query grantApproval uses, so the UI and the transaction cannot diverge.
  auditApprovedForCurrentCandidate: boolean
  // Whether a pending, unexpired approval exists — evaluated against `now`, never
  // trusted from the stored state alone.
  approvalPendingAndValid: boolean
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
  // Phase 6. True only when a succeeded review run bound to the CURRENT artifact
  // exists. Resolved by the repository in the SAME call that produced the
  // criteria's covered flags, so the two can never describe different runs.
  coverageAvailable: boolean
  // Phase 7. The candidate's own tree OID is deliberately NOT a source field:
  // only the APPROVED one reaches this builder, via auditApprovedTreeOid, and
  // even that is shortened. A pending candidate's identity never crosses.
  candidateStatus: string | null
  codeAuditRunStatus: CodeAuditRunStatus | null
  codeAuditVerdict: ReviewVerdict | null
  codeAuditReasonCode: CodeAuditReasonCode | null
  // HOW the latest audit reached its model — see AuditedTaskStatusProjection
  // for why this is projected. Null when no audit has run.
  codeAuditMode: AuditMode | null
  codeAuditSummary: string | null
  codeAuditFindingCount: number | null
  fixRoundLimit: number
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
    commitReasonCode: source.commitReasonCode,
    commitAdvisoryCode: source.commitAdvisoryCode,
    // Approve is offered ONLY for a task resting in awaiting_human_approval whose
    // CURRENT candidate carries the code audit's durable `approved` verdict.
    // Deliberately not a function of fixRound — a round-3 candidate stays
    // approvable, exactly as planApprovalReady ignores planRound.
    commitApprovalReady:
      source.state === 'awaiting_human_approval' && source.auditApprovedForCurrentCandidate,
    // Commit additionally requires a live approval and a still-current candidate.
    // Expiry is evaluated server-side, so a lapsed approval withdraws the
    // affordance without any renderer clock.
    commitReady:
      source.state === 'awaiting_human_approval' &&
      source.auditApprovedForCurrentCandidate &&
      source.approvalPendingAndValid &&
      source.candidateStatus === 'current',
    publishAttemptStatus: source.publishAttemptStatus,
    publishedShaShort: shortenCandidateId(source.publishedSha),
    publishReasonCode: source.publishReasonCode,
    publishAdvisoryCode: source.publishAdvisoryCode,
    reviewProvider: source.reviewProvider,
    reviewNumber: source.reviewNumber,
    reviewAvailable: source.reviewNumber !== null,
    // Publish requires a durable Phase 8 commit whose attempt is `completed` and
    // bound to the exact committed_sha. Deliberately excludes `authorized`: while
    // an attempt is live the outcome is unconfirmed, and offering Publish then
    // would risk a duplicate push.
    publishReady:
      source.state === 'committed' &&
      source.committedSha !== null &&
      source.commitAttemptPublishable &&
      source.publishAttemptStatus !== 'authorized',
    // The ONLY action offered while an outcome is unknown. Mutually exclusive
    // with publishReady by construction — both test publishAttemptStatus against
    // 'authorized' in opposite directions.
    publishRecheckAvailable: source.publishAttemptStatus === 'authorized',
    // Whether the SEPARATE creation retry exists at all is a server decision:
    // an unsupported provider offers none, and a stale renderer cannot invent one.
    reviewRequestRetryAvailable:
      source.publishAttemptStatus === 'completed' &&
      canRetryReviewRequest(source.publishAdvisoryCode),
    landAttemptStatus: source.landAttemptStatus,
    landedShaShort: shortenCandidateId(source.landedSha),
    landingReasonCode: source.landingReasonCode,
    landingAdvisoryCode: source.landingAdvisoryCode,
    // Land requires a durable Phase 8 commit AND a CONFIRMED Phase 9
    // publication bound to the same sha. Deliberately excludes `authorized` for
    // BOTH lanes: while either outcome is unconfirmed, offering Land would risk
    // integrating work whose publication state is unknown.
    //
    // Deliberately IGNORES publishAdvisoryCode: every review-request outcome is
    // advisory-only, and gating on one would refuse to land genuinely published
    // work — the precise error Phase 9's advisory/reason split exists to prevent.
    landReady:
      source.state === 'committed' &&
      source.committedSha !== null &&
      source.commitAttemptPublishable &&
      source.publishAttemptLandable &&
      source.landHostSupported &&
      source.publishAttemptStatus !== 'authorized' &&
      source.landAttemptStatus !== 'authorized',
    // The ONLY action offered while a land outcome is unknown. Mutually exclusive
    // with landReady by construction — both test landAttemptStatus against
    // 'authorized' in opposite directions.
    landRecheckAvailable: source.landAttemptStatus === 'authorized',
    // Whether the Land button should be offered again after a failure is a SERVER
    // decision: an ambiguous or diverged outcome offers none, and a stale renderer
    // cannot invent one.
    landRetryAvailable:
      source.state === 'committed' &&
      source.landAttemptStatus !== 'authorized' &&
      source.landingReasonCode !== null &&
      isRetryableLandingReasonCode(source.landingReasonCode),
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
    // Deliberately NOT folded into planApprovalReady: Phase 6 is bookkeeping, so
    // an incomplete matrix must not withhold an approval Codex already granted.
    coverageAvailable: source.coverageAvailable,
    // Available requires 'current' status: a superseded candidate still exists as
    // history, but it is not the work under audit.
    candidateAvailable: source.candidateStatus === 'current',
    codeAuditRunStatus: source.codeAuditRunStatus,
    codeAuditVerdict: source.codeAuditVerdict,
    codeAuditReasonCode: source.codeAuditReasonCode,
    codeAuditMode: source.codeAuditMode,
    codeAuditSummary: source.codeAuditSummary,
    codeAuditFindingCount: source.codeAuditFindingCount,
    // Request Fix is offered only from code_fixes_requested and only below the
    // round cap — the cap binds when STARTING a fix, nowhere else. Deliberately
    // NOT a function of the verdict: a task parked here already has one.
    codeFixAvailable:
      source.state === 'code_fixes_requested' && source.fixRound < source.fixRoundLimit,
    acceptanceCriteria: source.acceptanceCriteria,
    timings: source.timings,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  }
}

// Re-exported so existing importers are unaffected by the file split.
export { AUDITED_PROJECTION_FORBIDDEN_KEYS } from './audited-projection-forbidden-keys'
