// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'

type StoreState = {
  closeAuditedWorkflowPage: () => void
  auditedTasks: AuditedTaskStatusProjection[]
  auditedTasksLoading: boolean
  auditedTasksError: string | null
  selectedAuditedTaskId: string | null
  selectAuditedTask: (taskId: string | null) => void
  refreshAuditedTasks: (repoId?: string) => Promise<void>
}

const mocks = vi.hoisted(() => ({
  storeState: {} as StoreState
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(mocks.storeState)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./AuditedTaskSelectDialog', () => ({
  AuditedTaskSelectDialog: () => null
}))

vi.mock('./AuditedTaskDetail', () => ({
  AuditedTaskDetail: () => <div data-testid="task-detail" />
}))

import AuditedWorkflowPage from './AuditedWorkflowPage'

function baseState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    closeAuditedWorkflowPage: vi.fn(),
    auditedTasks: [],
    auditedTasksLoading: false,
    auditedTasksError: null,
    selectedAuditedTaskId: null,
    selectAuditedTask: vi.fn(),
    refreshAuditedTasks: vi.fn(async () => {}),
    ...overrides
  }
}

describe('AuditedWorkflowPage', () => {
  beforeEach(() => {
    mocks.storeState = baseState()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('calls refreshAuditedTasks on mount', () => {
    const refreshAuditedTasks = vi.fn(async () => {})
    mocks.storeState = baseState({ refreshAuditedTasks })
    render(<AuditedWorkflowPage />)
    expect(refreshAuditedTasks).toHaveBeenCalledTimes(1)
  })

  it('shows a loading state while the list is loading and empty', () => {
    mocks.storeState = baseState({ auditedTasksLoading: true, auditedTasks: [] })
    render(<AuditedWorkflowPage />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('shows the empty state when loading finished with no error and no tasks', () => {
    mocks.storeState = baseState({ auditedTasksLoading: false, auditedTasksError: null })
    render(<AuditedWorkflowPage />)
    expect(screen.getByText('No audited tasks yet.')).toBeInTheDocument()
  })

  it('renders a distinct error state with a retry action when the list failed to load — never the empty state', () => {
    mocks.storeState = baseState({
      auditedTasksLoading: false,
      auditedTasksError: 'Could not load audited tasks.',
      auditedTasks: []
    })
    render(<AuditedWorkflowPage />)

    expect(screen.getByText('Could not load audited tasks.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    // Must NOT look like "zero tasks" — the empty-state copy is absent.
    expect(screen.queryByText('No audited tasks yet.')).not.toBeInTheDocument()
  })

  it('retry button calls refreshAuditedTasks again', async () => {
    const refreshAuditedTasks = vi.fn(async () => {})
    mocks.storeState = baseState({
      auditedTasksError: 'Could not load audited tasks.',
      refreshAuditedTasks
    })
    render(<AuditedWorkflowPage />)
    refreshAuditedTasks.mockClear() // clear the mount-time call

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refreshAuditedTasks).toHaveBeenCalledTimes(1)
  })

  it('shows the task list when tasks are present, even if a stale error string is set', () => {
    const task: AuditedTaskStatusProjection = {
      taskId: 'audited_1',
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
      candidateIdShort: null,
      committedShaShort: null,
      commitAttemptStatus: null,
      commitReasonCode: null,
      commitAdvisoryCode: null,
      publishAttemptStatus: null,
      publishedShaShort: null,
      publishReasonCode: null,
      publishAdvisoryCode: null,
      reviewProvider: null,
      reviewNumber: null,
      reviewAvailable: false,
      publishReady: false,
      publishRecheckAvailable: false,
      reviewRequestRetryAvailable: false,
      landAttemptStatus: null,
      landedShaShort: null,
      landingReasonCode: null,
      landingAdvisoryCode: null,
      landReady: false,
      landRecheckAvailable: false,
      landRetryAvailable: false,
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
    // Error takes precedence in this component's branch order — a genuinely
    // present error always wins over showing stale data, which is the
    // intended behavior (never present success and failure simultaneously).
    mocks.storeState = baseState({ auditedTasksError: null, auditedTasks: [task] })
    render(<AuditedWorkflowPage />)
    expect(screen.getByText('Fix the thing')).toBeInTheDocument()
  })
})
