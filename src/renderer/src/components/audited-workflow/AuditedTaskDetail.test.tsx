// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'

type StoreState = {
  startAuditedTaskTriage: (taskId: string) => Promise<{ ok: boolean; reasonCode?: string }>
  retryAuditedTaskTriage: (taskId: string) => Promise<{ ok: boolean; reasonCode?: string }>
  auditedTriageStartingTaskId: string | null
}

const mocks = vi.hoisted(() => ({
  storeState: {} as StoreState,
  getTriageProviderStatus: vi.fn(),
  saveTriageApiKey: vi.fn(),
  clearTriageApiKey: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(mocks.storeState)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// Test window mock — no devTransition means isDevBuild is false. Cast as
// `never` (rather than `@ts-expect-error`) since only the subset of
// window.api.auditedWorkflow this component actually calls is provided.
globalThis.window.api = {
  auditedWorkflow: {
    getTriageProviderStatus: mocks.getTriageProviderStatus,
    saveTriageApiKey: mocks.saveTriageApiKey,
    clearTriageApiKey: mocks.clearTriageApiKey
  }
} as never

import { AuditedTaskDetail } from './AuditedTaskDetail'

function baseTask(
  overrides: Partial<AuditedTaskStatusProjection> = {}
): AuditedTaskStatusProjection {
  return {
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
    acceptanceCriteria: [],
    timings: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('AuditedTaskDetail — Start Triage control', () => {
  beforeEach(() => {
    mocks.storeState = {
      startAuditedTaskTriage: vi.fn(async () => ({ ok: true })),
      retryAuditedTaskTriage: vi.fn(async () => ({ ok: true })),
      auditedTriageStartingTaskId: null
    }
    mocks.getTriageProviderStatus.mockReset()
    mocks.saveTriageApiKey.mockReset()
    mocks.clearTriageApiKey.mockReset()
    mocks.getTriageProviderStatus.mockResolvedValue({ configured: false })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows a Start Triage button for a selected task and calls the store action on click', async () => {
    render(<AuditedTaskDetail task={baseTask({ state: 'selected' })} />)

    const button = screen.getByRole('button', { name: 'Start Triage' })
    expect(button).toBeInTheDocument()
    await userEvent.click(button)

    expect(mocks.storeState.startAuditedTaskTriage).toHaveBeenCalledWith('audited_1')
  })

  // Phase 3: the task stays `selected` while its worktree is prepared, so the
  // pending label distinguishes the two stages of the one Start Triage action.
  it('shows worktree preparation while the task has no verified worktree yet', () => {
    mocks.storeState.auditedTriageStartingTaskId = 'audited_1'
    render(<AuditedTaskDetail task={baseTask({ state: 'selected', worktreeReady: false })} />)

    const button = screen.getByRole('button', { name: 'Preparing worktree…' })
    expect(button).toBeDisabled()
  })

  it('shows a disabled running state once the worktree is ready and triage is in flight', () => {
    mocks.storeState.auditedTriageStartingTaskId = 'audited_1'
    render(<AuditedTaskDetail task={baseTask({ state: 'selected', worktreeReady: true })} />)

    const button = screen.getByRole('button', { name: 'Triage running…' })
    expect(button).toBeDisabled()
  })

  it('shows a disabled running state while the task itself is in the triaging state', () => {
    render(<AuditedTaskDetail task={baseTask({ state: 'triaging' })} />)

    const button = screen.getByRole('button', { name: 'Triage running…' })
    expect(button).toBeDisabled()
  })

  it('does not disable the running indicator for a DIFFERENT task currently starting triage', () => {
    mocks.storeState.auditedTriageStartingTaskId = 'some-other-task'
    render(<AuditedTaskDetail task={baseTask({ state: 'selected', taskId: 'audited_1' })} />)

    const button = screen.getByRole('button', { name: 'Start Triage' })
    expect(button).not.toBeDisabled()
  })

  it('shows the succeeded decision once triage moved the task to planning', () => {
    render(<AuditedTaskDetail task={baseTask({ state: 'planning', triageDecision: 'plan' })} />)
    expect(screen.getByText('plan')).toBeInTheDocument()
  })

  it('shows the succeeded decision once triage moved the task to ready_to_implement', () => {
    render(
      <AuditedTaskDetail
        task={baseTask({ state: 'ready_to_implement', triageDecision: 'direct' })}
      />
    )
    expect(screen.getByText('direct')).toBeInTheDocument()
  })

  it('shows a safe error message and a Retry button for a retryable blocked triage reason, and Retry calls retryAuditedTaskTriage', async () => {
    render(
      <AuditedTaskDetail
        task={baseTask({
          state: 'blocked',
          triageBlockedReasonCode: 'provider_unavailable',
          blockedReasonCode: 'provider_unavailable'
        })}
      />
    )

    expect(
      screen.getByText('Triage is not configured. Add an OpenAI API key to use this feature.')
    ).toBeInTheDocument()
    const retryButton = screen.getByRole('button', { name: 'Retry' })
    expect(retryButton).toBeInTheDocument()

    await userEvent.click(retryButton)
    expect(mocks.storeState.retryAuditedTaskTriage).toHaveBeenCalledWith('audited_1')
  })

  it('shows a Configure API Key button only for provider_unavailable, and it opens the key dialog', async () => {
    render(
      <AuditedTaskDetail
        task={baseTask({
          state: 'blocked',
          triageBlockedReasonCode: 'provider_unavailable',
          blockedReasonCode: 'provider_unavailable'
        })}
      />
    )

    const configureButton = screen.getByRole('button', { name: 'Configure API Key' })
    await userEvent.click(configureButton)

    expect(mocks.getTriageProviderStatus).toHaveBeenCalled()
    expect(await screen.findByText('Audited Workflow Triage')).toBeInTheDocument()
  })

  it('does not show a Configure API Key button for a non-key-related retryable reason (provider_timeout)', () => {
    render(
      <AuditedTaskDetail
        task={baseTask({
          state: 'blocked',
          triageBlockedReasonCode: 'provider_timeout',
          blockedReasonCode: 'provider_timeout'
        })}
      />
    )

    expect(screen.queryByRole('button', { name: 'Configure API Key' })).not.toBeInTheDocument()
    // The Retry button is still offered — provider_timeout is retryable.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('saving an API key calls the desktop-only IPC save method and never touches Zustand store state with the key value', async () => {
    mocks.saveTriageApiKey.mockResolvedValue({ configured: true })
    render(
      <AuditedTaskDetail
        task={baseTask({
          state: 'blocked',
          triageBlockedReasonCode: 'provider_unavailable',
          blockedReasonCode: 'provider_unavailable'
        })}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Configure API Key' }))
    await screen.findByText('Audited Workflow Triage')

    const input = screen.getByLabelText('API Key')
    await userEvent.type(input, 'sk-super-secret-value')
    await userEvent.click(screen.getByRole('button', { name: 'Save Key' }))

    expect(mocks.saveTriageApiKey).toHaveBeenCalledWith({ apiKey: 'sk-super-secret-value' })
    // The secret never reaches the mocked Zustand store object — only IPC.
    expect(JSON.stringify(mocks.storeState)).not.toContain('sk-super-secret-value')
  })

  it('clearing an API key calls the desktop-only IPC clear method', async () => {
    mocks.getTriageProviderStatus.mockResolvedValue({ configured: true })
    mocks.clearTriageApiKey.mockResolvedValue({ configured: false })
    render(
      <AuditedTaskDetail
        task={baseTask({
          state: 'blocked',
          triageBlockedReasonCode: 'provider_unavailable',
          blockedReasonCode: 'provider_unavailable'
        })}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Configure API Key' }))
    await screen.findByText('Audited Workflow Triage')

    const clearButton = await screen.findByRole('button', { name: 'Clear Key' })
    await userEvent.click(clearButton)

    expect(mocks.clearTriageApiKey).toHaveBeenCalled()
  })

  it('does not show a Retry button for a non-retryable blocked triage reason (lock_contended)', () => {
    render(
      <AuditedTaskDetail
        task={baseTask({
          state: 'blocked',
          triageBlockedReasonCode: 'lock_contended',
          blockedReasonCode: 'lock_contended'
        })}
      />
    )

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('a rejected saveTriageApiKey call never produces an unhandled promise rejection and re-enables the Save button', async () => {
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
      unhandledRejections.push(event.reason)
    }
    window.addEventListener('unhandledrejection', onUnhandledRejection)

    mocks.saveTriageApiKey.mockRejectedValue(new Error('unexpected preload failure'))
    render(
      <AuditedTaskDetail
        task={baseTask({
          state: 'blocked',
          triageBlockedReasonCode: 'provider_unavailable',
          blockedReasonCode: 'provider_unavailable'
        })}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Configure API Key' }))
    await screen.findByText('Audited Workflow Triage')

    const input = screen.getByLabelText('API Key')
    await userEvent.type(input, 'sk-test')
    await userEvent.click(screen.getByRole('button', { name: 'Save Key' }))

    // Give any unhandled rejection a chance to surface before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 0))
    window.removeEventListener('unhandledrejection', onUnhandledRejection)

    expect(unhandledRejections).toEqual([])
    expect(screen.getByRole('button', { name: 'Save Key' })).not.toBeDisabled()
  })

  it('a rejected clearTriageApiKey call never produces an unhandled promise rejection and re-enables the Clear button', async () => {
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
      unhandledRejections.push(event.reason)
    }
    window.addEventListener('unhandledrejection', onUnhandledRejection)

    mocks.getTriageProviderStatus.mockResolvedValue({ configured: true })
    mocks.clearTriageApiKey.mockRejectedValue(new Error('unexpected preload failure'))
    render(
      <AuditedTaskDetail
        task={baseTask({
          state: 'blocked',
          triageBlockedReasonCode: 'provider_unavailable',
          blockedReasonCode: 'provider_unavailable'
        })}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Configure API Key' }))
    const clearButton = await screen.findByRole('button', { name: 'Clear Key' })
    await userEvent.click(clearButton)

    await new Promise((resolve) => setTimeout(resolve, 0))
    window.removeEventListener('unhandledrejection', onUnhandledRejection)

    expect(unhandledRejections).toEqual([])
    expect(screen.getByRole('button', { name: 'Clear Key' })).not.toBeDisabled()
  })

  it('falls back to the generic blocked banner when blocked for a non-triage reason', () => {
    render(
      <AuditedTaskDetail
        task={baseTask({ state: 'blocked', blockedReasonCode: 'candidate_drift' })}
      />
    )

    expect(screen.getByText(/Blocked:/)).toBeInTheDocument()
    expect(screen.getByText(/candidate_drift/)).toBeInTheDocument()
  })
})
