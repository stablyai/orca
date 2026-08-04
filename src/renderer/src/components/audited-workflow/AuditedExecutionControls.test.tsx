// @vitest-environment happy-dom

// Phase 4 renderer behavior. The load-bearing assertions:
//  - a cancelled direct run leaves the task offering "Start Implementation";
//  - a failed retry preflight shows a TRANSIENT message and Retry ONLY — never
//    a recovery button, because an execution-blocked task is not admissible to
//    worktree recovery and offering one would promise an action that cannot work.
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'

type StoreState = {
  startAuditedTaskExecution: ReturnType<typeof vi.fn>
  cancelAuditedTaskExecution: ReturnType<typeof vi.fn>
  retryAuditedTaskExecution: ReturnType<typeof vi.fn>
  provisionAuditedTaskWorktree: ReturnType<typeof vi.fn>
  auditedExecutionPendingTaskId: string | null
}

const mocks = vi.hoisted(() => ({ storeState: {} as StoreState }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(mocks.storeState)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { AuditedExecutionControls } from './AuditedExecutionControls'

function task(overrides: Partial<AuditedTaskStatusProjection> = {}): AuditedTaskStatusProjection {
  return {
    taskId: 'audited_1',
    repoId: 'repo1',
    title: 'Fix the thing',
    state: 'ready_to_implement',
    activePhase: null,
    risk: 'low',
    source: 'custom',
    triageDecision: 'direct',
    triageRunStatus: 'succeeded',
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
    worktreeReady: true,
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
    acceptanceCriteria: [],
    timings: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as AuditedTaskStatusProjection
}

beforeEach(() => {
  mocks.storeState = {
    startAuditedTaskExecution: vi.fn().mockResolvedValue({ ok: true }),
    cancelAuditedTaskExecution: vi.fn().mockResolvedValue({ ok: true }),
    retryAuditedTaskExecution: vi.fn().mockResolvedValue({ ok: true }),
    provisionAuditedTaskWorktree: vi.fn().mockResolvedValue({ ok: true }),
    auditedExecutionPendingTaskId: null
  }
})

afterEach(cleanup)

describe('start affordances', () => {
  it('offers Start Planning in planning', () => {
    render(<AuditedExecutionControls task={task({ state: 'planning', triageDecision: 'plan' })} />)
    expect(screen.getByRole('button', { name: 'Start Planning' })).toBeEnabled()
  })

  it('offers Start Implementation in ready_to_implement', () => {
    render(<AuditedExecutionControls task={task()} />)
    expect(screen.getByRole('button', { name: 'Start Implementation' })).toBeEnabled()
  })

  it('renders implementing as a live-run state with Cancel, never as a resting state', () => {
    render(
      <AuditedExecutionControls
        task={task({ state: 'implementing', executionRunStatus: 'running' })}
      />
    )
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })
})

describe('after cancelling a direct run', () => {
  it('shows an enabled Start Implementation again (the strand regression)', () => {
    // Exactly what the projection looks like after cancelExecutionRun restores
    // the pre-launch state.
    render(
      <AuditedExecutionControls
        task={task({ state: 'ready_to_implement', executionRunStatus: 'cancelled' })}
      />
    )
    expect(screen.getByRole('button', { name: 'Start Implementation' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })
})

describe('blocked with an execution reason', () => {
  it('offers Retry for a retryable reason', () => {
    render(
      <AuditedExecutionControls
        task={task({
          state: 'blocked',
          executionRunStatus: 'failed',
          executionReasonCode: 'exit_nonzero'
        })}
      />
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('withholds Retry for a non-retryable reason', () => {
    render(
      <AuditedExecutionControls
        task={task({
          state: 'blocked',
          executionRunStatus: 'blocked',
          executionReasonCode: 'unexpected_commit_detected'
        })}
      />
    )
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('notes truncation without offering any way to view output', () => {
    render(
      <AuditedExecutionControls
        task={task({
          state: 'blocked',
          executionRunStatus: 'failed',
          executionReasonCode: 'exit_nonzero',
          executionOutputTruncated: true
        })}
      />
    )
    expect(screen.getByText('Output was truncated.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /view|output|log/i })).not.toBeInTheDocument()
  })
})

describe('failed retry preflight', () => {
  const blockedTask = task({
    state: 'blocked',
    executionRunStatus: 'failed',
    executionReasonCode: 'exit_nonzero'
  })

  async function clickRetryWith(reasonCode: string): Promise<void> {
    mocks.storeState.retryAuditedTaskExecution = vi
      .fn()
      .mockResolvedValue({ ok: false, kind: 'worktree', reasonCode, persisted: false })
    render(<AuditedExecutionControls task={blockedTask} />)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  }

  it('shows the transient message saying the task is still blocked', async () => {
    await clickRetryWith('head_moved_from_base_commit')
    expect(screen.getByText(/still blocked and nothing was changed/i)).toBeInTheDocument()
    expect(screen.getByText(/Resolve the worktree condition, then retry/i)).toBeInTheDocument()
  })

  it('keeps Retry enabled as the only offered action', async () => {
    await clickRetryWith('head_moved_from_base_commit')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it.each([
    'head_moved_from_base_commit', // a drift code
    'managed_root_unavailable', // a code that WOULD pass isRetryableWorktreeReasonCode
    'worktree_never_provisioned' // a code that WOULD pass needsExplicitWorktreeProvisioning
  ])('renders no recovery control for %s — the gate is unconditional', async (reasonCode) => {
    await clickRetryWith(reasonCode)

    expect(screen.queryByRole('button', { name: /Recover Worktree/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Provision Worktree/i })).not.toBeInTheDocument()
    expect(mocks.storeState.provisionAuditedTaskWorktree).not.toHaveBeenCalled()
  })

  it('never implies Orca will repair the worktree', async () => {
    await clickRetryWith('head_moved_from_base_commit')
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/we will (fix|repair|recover)/i)
    expect(text).not.toMatch(/recovering/i)
  })

  it('clears the transient message when the task changes', async () => {
    mocks.storeState.retryAuditedTaskExecution = vi.fn().mockResolvedValue({
      ok: false,
      kind: 'worktree',
      reasonCode: 'head_moved_from_base_commit',
      persisted: false
    })
    const { rerender } = render(<AuditedExecutionControls task={blockedTask} />)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByText(/still blocked/i)).toBeInTheDocument()

    rerender(
      <AuditedExecutionControls
        task={task({
          taskId: 'audited_2',
          state: 'blocked',
          executionRunStatus: 'failed',
          executionReasonCode: 'exit_nonzero'
        })}
      />
    )

    expect(screen.queryByText(/still blocked/i)).not.toBeInTheDocument()
  })

  it('shows nothing transient when the retry succeeds', async () => {
    render(<AuditedExecutionControls task={blockedTask} />)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.queryByText(/still blocked/i)).not.toBeInTheDocument()
  })

  // A PERSISTED worktree reason is already on the projection, so the existing
  // persisted-reason block renders it. Holding it as transient state here would
  // double-render it AND claim nothing was changed when the task was blocked.
  it('does not hold a persisted worktree reason as transient state', async () => {
    mocks.storeState.retryAuditedTaskExecution = vi.fn().mockResolvedValue({
      ok: false,
      kind: 'worktree',
      reasonCode: 'head_moved_from_base_commit',
      persisted: true
    })
    render(<AuditedExecutionControls task={blockedTask} />)

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(screen.queryByText(/still blocked and nothing was changed/i)).not.toBeInTheDocument()
    expect(mocks.storeState.provisionAuditedTaskWorktree).not.toHaveBeenCalled()
  })
})

describe('parked review states', () => {
  // Phase 7 moved the dead-end forward to awaiting_human_approval; Phase 8
  // removes it entirely. awaiting_human_approval, committing, and committed are
  // now owned by AuditedCommitPanel, so these controls render nothing for them —
  // the same relationship they already have with awaiting_plan_review and
  // awaiting_code_audit. Duplicating affordances across two panels would let the
  // two disagree.
  it('renders nothing in awaiting_code_audit, which the code-audit panel owns', () => {
    const { container } = render(
      <AuditedExecutionControls task={task({ state: 'awaiting_code_audit' })} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it.each(['awaiting_human_approval', 'committing', 'committed'] as const)(
    'renders nothing in %s, which the commit panel owns',
    (state) => {
      const { container } = render(<AuditedExecutionControls task={task({ state })} />)
      expect(container).toBeEmptyDOMElement()
    }
  )

  it('renders nothing in awaiting_plan_review, which the plan-review panel owns', () => {
    const { container } = render(
      <AuditedExecutionControls task={task({ state: 'awaiting_plan_review' })} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
