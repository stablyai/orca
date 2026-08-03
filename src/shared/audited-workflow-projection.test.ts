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
    blockedReasonCode: null,
    approvalState: 'none',
    approvalExpiresAt: null,
    auditApprovedTreeOid: null,
    committedSha: null,
    commitAttemptStatus: null,
    reconcileClass: null,
    reconcileReasonCode: null,
    worktreeProvenance: null,
    worktreeVerifiedAt: null,
    worktreeReasonCode: null,
    executionRunStatus: null,
    executionReasonCode: null,
    executionOutputTruncated: false,
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
