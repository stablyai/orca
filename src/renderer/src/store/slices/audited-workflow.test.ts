import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createAuditedWorkflowSlice } from './audited-workflow'
import type { AppState } from '../types'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'

const mockApi = {
  auditedWorkflow: {
    listTasks: vi.fn(),
    getTask: vi.fn(),
    selectTask: vi.fn(),
    startTriage: vi.fn(),
    retryTriage: vi.fn(),
    onTaskChanged: vi.fn()
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function createTestStore() {
  return create<AppState>()(
    (...a) => ({ ...createAuditedWorkflowSlice(...a) }) as unknown as AppState
  )
}

function makeTask(taskId: string): AuditedTaskStatusProjection {
  return {
    taskId,
    repoId: 'repo1',
    title: 'Task',
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
    commitReasonCode: null,
    commitAdvisoryCode: null,
    commitApprovalReady: false,
    commitReady: false,
    reconcileClass: null,
    reconcileReasonCode: null,
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
    createdAt: 1,
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
    updatedAt: 1
  }
}

describe('createAuditedWorkflowSlice', () => {
  beforeEach(() => {
    mockApi.auditedWorkflow.listTasks.mockReset()
    mockApi.auditedWorkflow.getTask.mockReset()
    mockApi.auditedWorkflow.selectTask.mockReset()
    mockApi.auditedWorkflow.startTriage.mockReset()
    mockApi.auditedWorkflow.retryTriage.mockReset()
  })

  it('refreshAuditedTasks populates the list on success', async () => {
    mockApi.auditedWorkflow.listTasks.mockResolvedValue([makeTask('t1')])
    const store = createTestStore()

    await store.getState().refreshAuditedTasks()

    expect(store.getState().auditedTasks.map((t) => t.taskId)).toEqual(['t1'])
    expect(store.getState().auditedTasksError).toBeNull()
    expect(store.getState().auditedTasksLoading).toBe(false)
  })

  it('refreshAuditedTasks sets a user-safe error and does NOT clear a previously loaded list on failure', async () => {
    mockApi.auditedWorkflow.listTasks.mockResolvedValueOnce([makeTask('t1')])
    const store = createTestStore()
    await store.getState().refreshAuditedTasks()
    expect(store.getState().auditedTasks).toHaveLength(1)

    mockApi.auditedWorkflow.listTasks.mockRejectedValueOnce(
      new Error('ENOENT: /var/lib/orca/audited-workflow.db')
    )
    await store.getState().refreshAuditedTasks()

    // Error is set and is NOT the raw exception message.
    expect(store.getState().auditedTasksError).not.toBeNull()
    expect(store.getState().auditedTasksError).not.toContain('/var/lib/orca')
    expect(store.getState().auditedTasksError).not.toContain('ENOENT')
    // The stale list is preserved rather than silently emptied — the caller
    // (AuditedWorkflowPage) distinguishes "error" from "empty" via the error
    // field, not by inferring it from an emptied list.
    expect(store.getState().auditedTasks).toHaveLength(1)
    expect(store.getState().auditedTasksLoading).toBe(false)
  })

  it('refreshAuditedTasks clears a previous error on a subsequent successful load', async () => {
    mockApi.auditedWorkflow.listTasks.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    await store.getState().refreshAuditedTasks()
    expect(store.getState().auditedTasksError).not.toBeNull()

    mockApi.auditedWorkflow.listTasks.mockResolvedValueOnce([makeTask('t1')])
    await store.getState().refreshAuditedTasks()
    expect(store.getState().auditedTasksError).toBeNull()
  })

  it('createAuditedTask on success sets selectedAuditedTaskId and refreshes the list', async () => {
    mockApi.auditedWorkflow.selectTask.mockResolvedValue({ ok: true, taskId: 'new-task' })
    mockApi.auditedWorkflow.listTasks.mockResolvedValue([makeTask('new-task')])
    const store = createTestStore()

    const result = await store.getState().createAuditedTask({
      repoId: 'repo1',
      source: 'custom',
      title: 'x',
      description: '',
      risk: 'low'
    })

    expect(result).toEqual({ ok: true, taskId: 'new-task' })
    expect(store.getState().selectedAuditedTaskId).toBe('new-task')
    expect(mockApi.auditedWorkflow.listTasks).toHaveBeenCalled()
  })

  it('createAuditedTask on failure returns the structured result WITHOUT selecting a task or refreshing', async () => {
    mockApi.auditedWorkflow.selectTask.mockResolvedValue({
      ok: false,
      reasonCode: 'unsupported_host'
    })
    const store = createTestStore()

    const result = await store.getState().createAuditedTask({
      repoId: 'repo1',
      source: 'custom',
      title: 'x',
      description: '',
      risk: 'low'
    })

    expect(result).toEqual({ ok: false, reasonCode: 'unsupported_host' })
    expect(store.getState().selectedAuditedTaskId).toBeNull()
    expect(mockApi.auditedWorkflow.listTasks).not.toHaveBeenCalled()
  })

  it('startAuditedTaskTriage sets and clears auditedTriageStartingTaskId around the call, and upserts the returned projection', async () => {
    mockApi.auditedWorkflow.startTriage.mockResolvedValue({ ok: true })
    mockApi.auditedWorkflow.getTask.mockResolvedValue({ ...makeTask('t1'), state: 'planning' })
    const store = createTestStore()

    const pending = store.getState().startAuditedTaskTriage('t1')
    expect(store.getState().auditedTriageStartingTaskId).toBe('t1')
    const result = await pending

    expect(result).toEqual({ ok: true })
    expect(store.getState().auditedTriageStartingTaskId).toBeNull()
    expect(store.getState().auditedTasks.find((t) => t.taskId === 't1')?.state).toBe('planning')
  })

  it('startAuditedTaskTriage clears auditedTriageStartingTaskId even when the result is a failure', async () => {
    mockApi.auditedWorkflow.startTriage.mockResolvedValue({
      ok: false,
      reasonCode: 'provider_unavailable'
    })
    mockApi.auditedWorkflow.getTask.mockResolvedValue(makeTask('t1'))
    const store = createTestStore()

    const result = await store.getState().startAuditedTaskTriage('t1')

    expect(result).toEqual({ ok: false, reasonCode: 'provider_unavailable' })
    expect(store.getState().auditedTriageStartingTaskId).toBeNull()
  })

  it('retryAuditedTaskTriage sets and clears auditedTriageStartingTaskId around the call, and upserts the returned projection', async () => {
    mockApi.auditedWorkflow.retryTriage.mockResolvedValue({ ok: true })
    mockApi.auditedWorkflow.getTask.mockResolvedValue({
      ...makeTask('t1'),
      state: 'ready_to_implement'
    })
    const store = createTestStore()

    const pending = store.getState().retryAuditedTaskTriage('t1')
    expect(store.getState().auditedTriageStartingTaskId).toBe('t1')
    const result = await pending

    expect(result).toEqual({ ok: true })
    expect(store.getState().auditedTriageStartingTaskId).toBeNull()
    expect(mockApi.auditedWorkflow.retryTriage).toHaveBeenCalledWith({ taskId: 't1' })
    expect(store.getState().auditedTasks.find((t) => t.taskId === 't1')?.state).toBe(
      'ready_to_implement'
    )
  })

  it('retryAuditedTaskTriage clears auditedTriageStartingTaskId even when the result is a failure', async () => {
    mockApi.auditedWorkflow.retryTriage.mockResolvedValue({
      ok: false,
      reasonCode: 'illegal_transition'
    })
    mockApi.auditedWorkflow.getTask.mockResolvedValue(makeTask('t1'))
    const store = createTestStore()

    const result = await store.getState().retryAuditedTaskTriage('t1')

    expect(result).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    expect(store.getState().auditedTriageStartingTaskId).toBeNull()
  })

  it('applyAuditedTaskChanged upserts by taskId', () => {
    const store = createTestStore()
    store.getState().applyAuditedTaskChanged(makeTask('t1'))
    expect(store.getState().auditedTasks).toHaveLength(1)

    const updated = { ...makeTask('t1'), title: 'Updated' }
    store.getState().applyAuditedTaskChanged(updated)
    expect(store.getState().auditedTasks).toHaveLength(1)
    expect(store.getState().auditedTasks[0].title).toBe('Updated')
  })
})
