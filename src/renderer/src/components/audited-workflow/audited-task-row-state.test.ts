import { describe, expect, it } from 'vitest'
import {
  getAuditedTaskBadgeTone,
  getAuditedTaskStateLabel,
  sortAuditedTasksByRecency
} from './audited-task-row-state'
import { AUDITED_TASK_STATES } from '../../../../shared/audited-workflow-types'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'

describe('getAuditedTaskBadgeTone', () => {
  it('classifies blocked as blocked', () => {
    expect(getAuditedTaskBadgeTone('blocked')).toBe('blocked')
  })

  it('classifies landed as success', () => {
    expect(getAuditedTaskBadgeTone('landed')).toBe('success')
  })

  it('classifies selected and cancelled as neutral', () => {
    expect(getAuditedTaskBadgeTone('selected')).toBe('neutral')
    expect(getAuditedTaskBadgeTone('cancelled')).toBe('neutral')
  })

  it('classifies every other state as progress', () => {
    const excluded = new Set(['blocked', 'landed', 'selected', 'cancelled'])
    for (const state of AUDITED_TASK_STATES) {
      if (excluded.has(state)) {
        continue
      }
      expect(getAuditedTaskBadgeTone(state)).toBe('progress')
    }
  })
})

describe('getAuditedTaskStateLabel', () => {
  it('returns a non-empty label for every state', () => {
    for (const state of AUDITED_TASK_STATES) {
      expect(getAuditedTaskStateLabel(state).length).toBeGreaterThan(0)
    }
  })

  it('returns distinct labels for every state', () => {
    const labels = AUDITED_TASK_STATES.map(getAuditedTaskStateLabel)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

function makeProjection(taskId: string, updatedAt: number): AuditedTaskStatusProjection {
  return {
    taskId,
    repoId: 'repo1',
    title: taskId,
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
    candidateIdShort: null,
    committedShaShort: null,
    commitAttemptStatus: null,
    reconcileClass: null,
    reconcileReasonCode: null,
    worktreeReady: false,
    worktreeReasonCode: null,
    executionRunStatus: null,
    executionReasonCode: null,
    executionOutputTruncated: false,
    planArtifactId: null,
    planArtifactAvailable: false,
    planArtifactTruncated: false,
    planArtifactRedactionCount: 0,
    planReviewRunStatus: null,
    planReviewVerdict: null,
    planReviewReasonCode: null,
    planReviewSummary: null,
    planReviewFindingCount: null,
    planApprovalReady: false,
    planRevisionAvailable: false,
    coverageAvailable: false,
    candidateAvailable: false,
    codeAuditRunStatus: null,
    codeAuditVerdict: null,
    codeAuditReasonCode: null,
    codeAuditSummary: null,
    codeAuditFindingCount: null,
    codeFixAvailable: false,
    acceptanceCriteria: [],
    timings: [],
    createdAt: updatedAt,
    updatedAt
  }
}

describe('sortAuditedTasksByRecency', () => {
  it('sorts by updatedAt descending without mutating the input', () => {
    const tasks = [makeProjection('a', 100), makeProjection('b', 300), makeProjection('c', 200)]
    const sorted = sortAuditedTasksByRecency(tasks)

    expect(sorted.map((t) => t.taskId)).toEqual(['b', 'c', 'a'])
    expect(tasks.map((t) => t.taskId)).toEqual(['a', 'b', 'c'])
  })
})
