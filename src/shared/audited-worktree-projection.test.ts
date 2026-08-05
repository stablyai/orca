// Phase 3 projection guarantees: only sanitized worktree readiness crosses the
// boundary, and Audited Workflow stays Electron-desktop-only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AUDITED_PROJECTION_FORBIDDEN_KEYS,
  buildAuditedTaskProjection,
  type ProjectionSourceTask
} from './audited-workflow-projection'

function source(overrides: Partial<ProjectionSourceTask> = {}): ProjectionSourceTask {
  return {
    taskId: 'audited_1',
    repoId: 'repo1',
    title: 'Do the thing',
    state: 'selected',
    activePhase: null,
    risk: 'low',
    source: 'custom',
    triageDecision: null,
    triageRunStatus: null,
    triageBlockedReasonCode: null,
    planRound: 0,
    fixRound: 0,
    planArtifactId: null,
    planArtifactStatus: null,
    planArtifactTruncated: false,
    planArtifactRedactionCount: 0,
    planReviewRunStatus: null,
    planReviewVerdict: null,
    planReviewReasonCode: null,
    planReviewSummary: null,
    planReviewFindingCount: null,
    planReviewApprovedForCurrentArtifact: false,
    lastVerdict: null,
    blockedReasonCode: null,
    approvalState: 'none',
    approvalExpiresAt: null,
    auditApprovedTreeOid: null,
    committedSha: null,
    commitAttemptStatus: null,
    commitReasonCode: null,
    commitAdvisoryCode: null,
    publishAttemptStatus: null,
    publishedSha: null,
    publishReasonCode: null,
    publishAdvisoryCode: null,
    reviewProvider: null,
    reviewNumber: null,
    commitAttemptPublishable: false,
    landAttemptStatus: null,
    landedSha: null,
    landingReasonCode: null,
    landingAdvisoryCode: null,
    publishAttemptLandable: false,
    landHostSupported: true,
    auditApprovedForCurrentCandidate: false,
    approvalPendingAndValid: false,
    reconcileClass: null,
    reconcileReasonCode: null,
    worktreeProvenance: null,
    worktreeVerifiedAt: null,
    worktreeReasonCode: null,
    executionRunStatus: null,
    executionReasonCode: null,
    executionOutputTruncated: false,
    coverageAvailable: false,
    candidateStatus: null,
    codeAuditRunStatus: null,
    codeAuditVerdict: null,
    codeAuditReasonCode: null,
    codeAuditMode: null,
    codeAuditSummary: null,
    codeAuditFindingCount: null,
    fixRoundLimit: 3,
    acceptanceCriteria: [],
    timings: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

describe('worktreeReady requires all three conditions', () => {
  it('is true only for a provisioned, verified, failure-free worktree', () => {
    expect(
      buildAuditedTaskProjection(
        source({
          worktreeProvenance: 'orca_audited_v1',
          worktreeVerifiedAt: 1_700_000_000_000,
          worktreeReasonCode: null
        })
      ).worktreeReady
    ).toBe(true)
  })

  it('is false when nothing has been provisioned', () => {
    expect(buildAuditedTaskProjection(source()).worktreeReady).toBe(false)
  })

  it('is false when provenance is missing but verification exists', () => {
    expect(
      buildAuditedTaskProjection(
        source({ worktreeProvenance: null, worktreeVerifiedAt: 1_700_000_000_000 })
      ).worktreeReady
    ).toBe(false)
  })

  // Provenance alone is insufficient: it records that a worktree was finalized,
  // not that it is currently verified.
  it('is false when provenance exists but verification never ran', () => {
    expect(
      buildAuditedTaskProjection(
        source({ worktreeProvenance: 'orca_audited_v1', worktreeVerifiedAt: null })
      ).worktreeReady
    ).toBe(false)
  })

  it('is false when a worktree failure is recorded, even if verified earlier', () => {
    expect(
      buildAuditedTaskProjection(
        source({
          worktreeProvenance: 'orca_audited_v1',
          worktreeVerifiedAt: 1_700_000_000_000,
          worktreeReasonCode: 'worktree_missing'
        })
      ).worktreeReady
    ).toBe(false)
  })

  it('is false when every condition is missing at once', () => {
    expect(
      buildAuditedTaskProjection(
        source({
          worktreeProvenance: null,
          worktreeVerifiedAt: null,
          worktreeReasonCode: 'provision_evidence_ambiguous'
        })
      ).worktreeReady
    ).toBe(false)
  })
})

describe('worktree projection', () => {
  it('exposes the closed reason code and nothing else about the worktree', () => {
    const projection = buildAuditedTaskProjection(
      source({ worktreeReasonCode: 'head_moved_from_base_commit' })
    )

    expect(projection.worktreeReasonCode).toBe('head_moved_from_base_commit')
    for (const key of AUDITED_PROJECTION_FORBIDDEN_KEYS) {
      expect(projection).not.toHaveProperty(key)
    }
    // Defense in depth: no value anywhere in the payload looks like a path.
    const serialized = JSON.stringify(projection)
    expect(serialized).not.toContain('.orca-audited')
    expect(serialized).not.toContain('orca/audited')
  })

  it('forbids every Phase 3 identity field by name', () => {
    for (const key of [
      'branchName',
      'worktreeId',
      'worktreeProvenanceId',
      'sourceRepoCommonDir',
      'intendedPath',
      'intendedBranch'
    ]) {
      expect(AUDITED_PROJECTION_FORBIDDEN_KEYS).toContain(key)
    }
  })
})

describe('Audited Workflow stays Electron-desktop-only', () => {
  const SRC = join(__dirname, '..')

  it('registers no RPC method for auditedWorkflow or auditedWorktree', () => {
    const methodsDir = join(SRC, 'main', 'runtime', 'rpc', 'methods')
    const index = readFileSync(join(methodsDir, 'index.ts'), 'utf8')

    expect(index).not.toContain('auditedWorkflow')
    expect(index).not.toContain('auditedWorktree')
  })

  it('keeps the audited IPC surface out of the mobile RPC allowlist', () => {
    const allowlist = readFileSync(
      join(SRC, 'main', 'runtime', 'mobile-rpc-allowlist.test.ts'),
      'utf8'
    )

    expect(allowlist).not.toContain("'auditedWorkflow.")
    expect(allowlist).not.toContain("'auditedWorktree.")
  })

  // Read rather than imported: this file belongs to the shared TS project, which
  // deliberately cannot reference main. The gate's own behavior is unit-tested
  // in main/ipc/audited-workflow-dev-transitions-gate.test.ts.
  it('keeps the developer transition capability gated on a non-packaged build', () => {
    const gate = readFileSync(
      join(SRC, 'main', 'ipc', 'audited-workflow-dev-transitions-gate.ts'),
      'utf8'
    )

    expect(gate).toContain('return !isPackaged')
  })
})
