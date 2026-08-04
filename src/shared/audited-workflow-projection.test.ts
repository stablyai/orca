import { describe, expect, it } from 'vitest'
import {
  buildAuditedTaskProjection,
  shortenCandidateId,
  AUDITED_PROJECTION_FORBIDDEN_KEYS,
  type ProjectionSourceTask
} from './audited-workflow-projection'

function baseSource(overrides: Partial<ProjectionSourceTask> = {}): ProjectionSourceTask {
  return {
    taskId: 'audited_abc123',
    repoId: 'repo1',
    title: 'Fix the thing',
    state: 'selected',
    activePhase: null,
    risk: 'low',
    source: 'custom',
    triageDecision: null,
    triageRunStatus: null,
    triageBlockedReasonCode: null,
    planRound: 0,
    fixRound: 0,
    lastVerdict: null,
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
    codeAuditSummary: null,
    codeAuditFindingCount: null,
    fixRoundLimit: 3,
    acceptanceCriteria: [],
    timings: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides
  }
}

describe('shortenCandidateId', () => {
  it('truncates to 12 characters', () => {
    const full = 'a'.repeat(40)
    expect(shortenCandidateId(full)).toBe('a'.repeat(12))
    expect(shortenCandidateId(full)?.length).toBe(12)
  })

  it('returns null for null input', () => {
    expect(shortenCandidateId(null)).toBeNull()
  })
})

describe('buildAuditedTaskProjection', () => {
  it('maps every field from source to projection', () => {
    const source = baseSource({
      auditApprovedTreeOid: 'b'.repeat(40),
      committedSha: 'c'.repeat(40)
    })
    const projection = buildAuditedTaskProjection(source)

    expect(projection.taskId).toBe(source.taskId)
    expect(projection.repoId).toBe(source.repoId)
    expect(projection.title).toBe(source.title)
    expect(projection.state).toBe(source.state)
    expect(projection.candidateIdShort).toBe('b'.repeat(12))
    expect(projection.committedShaShort).toBe('c'.repeat(12))
    expect(projection.createdAt).toBe(source.createdAt)
    expect(projection.updatedAt).toBe(source.updatedAt)
  })

  it('never exposes the full auditApprovedTreeOid or committedSha value', () => {
    const fullTreeOid = 'd'.repeat(40)
    const fullSha = 'e'.repeat(40)
    const projection = buildAuditedTaskProjection(
      baseSource({ auditApprovedTreeOid: fullTreeOid, committedSha: fullSha })
    )

    const serialized = JSON.stringify(projection)
    expect(serialized).not.toContain(fullTreeOid)
    expect(serialized).not.toContain(fullSha)
  })

  it('does not expose any key on the forbidden-key denylist', () => {
    const projection = buildAuditedTaskProjection(
      baseSource({ auditApprovedTreeOid: 'f'.repeat(40), committedSha: 'g'.repeat(40) })
    )
    const keys = Object.keys(projection)
    for (const forbidden of AUDITED_PROJECTION_FORBIDDEN_KEYS) {
      expect(keys, `projection must not contain forbidden key "${forbidden}"`).not.toContain(
        forbidden
      )
    }
  })

  it('handles null tree oid / sha as null short forms', () => {
    const projection = buildAuditedTaskProjection(baseSource())
    expect(projection.candidateIdShort).toBeNull()
    expect(projection.committedShaShort).toBeNull()
  })
})

// R14. Phase 6 is BOOKKEEPING. Coverage is displayed, never enforced — so an
// incomplete matrix must not withhold an approval Codex already granted, and a
// complete one must not manufacture an approval it did not. If a future phase
// decides to gate on coverage, this suite is the thing that must change first,
// deliberately.
describe('coverage never gates approval', () => {
  const approvable = {
    state: 'awaiting_plan_review' as const,
    planArtifactId: 'plan_1',
    planArtifactStatus: 'current',
    planReviewApprovedForCurrentArtifact: true
  }

  it.each([
    ['fully covered', true, [{ id: 'ac1', text: 'a', covered: true }]],
    ['partially covered', true, [{ id: 'ac1', text: 'a', covered: false }]],
    ['audited with no criteria', true, []],
    ['never audited', false, [{ id: 'ac1', text: 'a', covered: false }]]
  ])('stays approvable when %s', (_label, coverageAvailable, acceptanceCriteria) => {
    const projection = buildAuditedTaskProjection(
      baseSource({ ...approvable, coverageAvailable, acceptanceCriteria })
    )
    expect(projection.planApprovalReady).toBe(true)
  })

  it('does not make an unapproved plan approvable just because coverage is complete', () => {
    const projection = buildAuditedTaskProjection(
      baseSource({
        ...approvable,
        planReviewApprovedForCurrentArtifact: false,
        coverageAvailable: true,
        acceptanceCriteria: [{ id: 'ac1', text: 'a', covered: true }]
      })
    )
    expect(projection.planApprovalReady).toBe(false)
  })

  it('passes coverageAvailable through untouched', () => {
    expect(
      buildAuditedTaskProjection(baseSource({ coverageAvailable: true })).coverageAvailable
    ).toBe(true)
    expect(
      buildAuditedTaskProjection(baseSource({ coverageAvailable: false })).coverageAvailable
    ).toBe(false)
  })
})

// P1 / P2 — Phase 7. The candidate tree OID is AUTHORIZATION identity: the full
// value must never cross, and a PENDING candidate's identity must not cross at
// all. Only the approved tree reaches the renderer, as candidateIdShort.
describe('code-audit projection never leaks candidate identity', () => {
  const TREE_OID = `${'ab12cd34ef56'.repeat(3)}abcd`

  it('never exposes the full approved tree OID, only the 12-char short form', () => {
    const projection = buildAuditedTaskProjection(
      baseSource({ auditApprovedTreeOid: TREE_OID, candidateStatus: 'current' })
    )

    expect(projection.candidateIdShort).toBe(TREE_OID.slice(0, 12))
    expect(JSON.stringify(projection)).not.toContain(TREE_OID)
  })

  it('exposes no candidate identity at all before approval', () => {
    const projection = buildAuditedTaskProjection(
      baseSource({ auditApprovedTreeOid: null, candidateStatus: 'current' })
    )

    // The candidate exists and is auditable, but nothing identifies it.
    expect(projection.candidateAvailable).toBe(true)
    expect(projection.candidateIdShort).toBeNull()
  })

  it('reports candidateAvailable only for a current candidate', () => {
    expect(
      buildAuditedTaskProjection(baseSource({ candidateStatus: 'current' })).candidateAvailable
    ).toBe(true)
    expect(
      buildAuditedTaskProjection(baseSource({ candidateStatus: 'superseded' })).candidateAvailable
    ).toBe(false)
    expect(
      buildAuditedTaskProjection(baseSource({ candidateStatus: null })).candidateAvailable
    ).toBe(false)
  })

  it('gates codeFixAvailable on the state AND the round cap', () => {
    const inFixState = { state: 'code_fixes_requested' as const, fixRoundLimit: 3 }
    expect(
      buildAuditedTaskProjection(baseSource({ ...inFixState, fixRound: 2 })).codeFixAvailable
    ).toBe(true)
    expect(
      buildAuditedTaskProjection(baseSource({ ...inFixState, fixRound: 3 })).codeFixAvailable
    ).toBe(false)
    // Not offered outside the fix state, whatever the round.
    expect(
      buildAuditedTaskProjection(
        baseSource({ state: 'awaiting_code_audit', fixRound: 0, fixRoundLimit: 3 })
      ).codeFixAvailable
    ).toBe(false)
  })

  it('passes the audit verdict facts through untouched', () => {
    const projection = buildAuditedTaskProjection(
      baseSource({
        codeAuditRunStatus: 'succeeded',
        codeAuditVerdict: 'fixes_requested',
        codeAuditReasonCode: null,
        codeAuditSummary: 'Two defects.',
        codeAuditFindingCount: 2
      })
    )

    expect(projection).toMatchObject({
      codeAuditRunStatus: 'succeeded',
      codeAuditVerdict: 'fixes_requested',
      codeAuditSummary: 'Two defects.',
      codeAuditFindingCount: 2
    })
  })

  // Phase 7 does not touch the plan lane's approval authority.
  it('leaves planApprovalReady unaffected by code-audit state', () => {
    const projection = buildAuditedTaskProjection(
      baseSource({
        state: 'awaiting_plan_review',
        planArtifactId: 'plan_1',
        planArtifactStatus: 'current',
        planReviewApprovedForCurrentArtifact: true,
        candidateStatus: 'current',
        codeAuditVerdict: 'blocked'
      })
    )
    expect(projection.planApprovalReady).toBe(true)
  })
})

describe('Phase 9 publish authorities', () => {
  it('offers Publish only for a committed task with a publishable commit attempt', () => {
    const ready = buildAuditedTaskProjection(
      baseSource({
        state: 'committed',
        committedSha: 'c'.repeat(40),
        commitAttemptPublishable: true
      })
    )
    expect(ready.publishReady).toBe(true)
    expect(ready.publishRecheckAvailable).toBe(false)
  })

  it.each([
    ['not committed', { state: 'awaiting_human_approval' as const }],
    ['no committed sha', { committedSha: null }],
    ['commit attempt not publishable', { commitAttemptPublishable: false }]
  ])('withholds Publish when %s', (_label, overrides) => {
    const projection = buildAuditedTaskProjection(
      baseSource({
        state: 'committed',
        committedSha: 'c'.repeat(40),
        commitAttemptPublishable: true,
        ...overrides
      })
    )
    expect(projection.publishReady).toBe(false)
  })

  it('offers ONLY Recheck while an attempt is authorized (mutually exclusive)', () => {
    const projection = buildAuditedTaskProjection(
      baseSource({
        state: 'committed',
        committedSha: 'c'.repeat(40),
        commitAttemptPublishable: true,
        publishAttemptStatus: 'authorized'
      })
    )
    expect(projection.publishRecheckAvailable).toBe(true)
    expect(projection.publishReady).toBe(false)
  })

  it('never offers Publish and Recheck at the same time, for any status', () => {
    for (const status of [
      null,
      'authorized',
      'completed',
      'failed_no_effect',
      'failed_ambiguous',
      'abandoned'
    ] as const) {
      const projection = buildAuditedTaskProjection(
        baseSource({
          state: 'committed',
          committedSha: 'c'.repeat(40),
          commitAttemptPublishable: true,
          publishAttemptStatus: status
        })
      )
      expect(projection.publishReady && projection.publishRecheckAvailable).toBe(false)
    }
  })

  it('offers the review-request retry only for a retryable advisory on a completed publish', () => {
    const retryable = buildAuditedTaskProjection(
      baseSource({
        state: 'committed',
        publishAttemptStatus: 'completed',
        publishAdvisoryCode: 'review_request_auth_required'
      })
    )
    expect(retryable.reviewRequestRetryAvailable).toBe(true)

    const terminal = buildAuditedTaskProjection(
      baseSource({
        state: 'committed',
        publishAttemptStatus: 'completed',
        publishAdvisoryCode: 'review_request_unsupported_provider'
      })
    )
    expect(terminal.reviewRequestRetryAvailable).toBe(false)
  })

  it('shortens the published sha and never projects the full value', () => {
    const full = 'c'.repeat(40)
    const projection = buildAuditedTaskProjection(baseSource({ publishedSha: full }))
    expect(projection.publishedShaShort).toBe(full.slice(0, 12))
    expect(JSON.stringify(projection)).not.toContain(full)
  })

  it('projects a review number as available', () => {
    const projection = buildAuditedTaskProjection(
      baseSource({ reviewNumber: 42, reviewProvider: 'gitlab' })
    )
    expect(projection.reviewAvailable).toBe(true)
    expect(projection.reviewNumber).toBe(42)
  })
})
