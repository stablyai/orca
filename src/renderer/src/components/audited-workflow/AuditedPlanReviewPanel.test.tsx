// @vitest-environment happy-dom

// Phase 5 renderer behavior. The load-bearing assertions:
//  - Approve appears ONLY when the SERVER says planApprovalReady;
//  - an `approved` verdict offers no "Request Revision" (no legal transition);
//  - a `blocked` verdict offers no "Revise Plan" (no recovery transition);
//  - the panel does not mount while a revision is running (`planning`).
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'

type StoreState = {
  startAuditedPlanAudit: ReturnType<typeof vi.fn>
  cancelAuditedPlanAudit: ReturnType<typeof vi.fn>
  retryAuditedPlanAudit: ReturnType<typeof vi.fn>
  approveAuditedPlan: ReturnType<typeof vi.fn>
  requestAuditedPlanRevision: ReturnType<typeof vi.fn>
  loadAuditedPlanArtifact: ReturnType<typeof vi.fn>
  auditedPlanReviewPendingTaskId: string | null
  auditedPlanArtifactBodies: Record<string, string>
}

const mocks = vi.hoisted(() => ({ storeState: {} as StoreState }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(mocks.storeState)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { AuditedPlanReviewPanel } from './AuditedPlanReviewPanel'

function task(overrides: Partial<AuditedTaskStatusProjection> = {}): AuditedTaskStatusProjection {
  return {
    taskId: 'audited_1',
    repoId: 'repo1',
    title: 'Fix the thing',
    state: 'awaiting_plan_review',
    activePhase: null,
    risk: 'low',
    source: 'custom',
    triageDecision: 'plan',
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
    worktreeReady: true,
    worktreeReasonCode: null,
    executionRunStatus: 'succeeded',
    executionReasonCode: null,
    executionOutputTruncated: false,
    planArtifactId: 'plan_a',
    planArtifactAvailable: true,
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
    codeAuditMode: null,
    codeAuditSummary: null,
    codeAuditFindingCount: null,
    codeFixAvailable: false,
    acceptanceCriteria: [],
    timings: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

beforeEach(() => {
  mocks.storeState = {
    startAuditedPlanAudit: vi.fn().mockResolvedValue({ ok: true }),
    cancelAuditedPlanAudit: vi.fn().mockResolvedValue({ ok: true }),
    retryAuditedPlanAudit: vi.fn().mockResolvedValue({ ok: true }),
    approveAuditedPlan: vi.fn().mockResolvedValue({ ok: true }),
    requestAuditedPlanRevision: vi.fn().mockResolvedValue({ ok: true }),
    loadAuditedPlanArtifact: vi.fn().mockResolvedValue({ ok: true, text: 'the plan' }),
    auditedPlanReviewPendingTaskId: null,
    auditedPlanArtifactBodies: {}
  }
})

afterEach(cleanup)

describe('mounting', () => {
  it.each(['selected', 'triaging', 'planning', 'ready_to_implement', 'implementing'] as const)(
    'does not mount in %s',
    (state) => {
      const { container } = render(<AuditedPlanReviewPanel task={task({ state })} />)
      expect(container).toBeEmptyDOMElement()
    }
  )

  // The revision-running case specifically: the execution controls own it.
  it('does not mount while a revision is running', () => {
    const { container } = render(
      <AuditedPlanReviewPanel task={task({ state: 'planning', planRound: 1 })} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('no audit yet', () => {
  it('offers Run Codex Audit', () => {
    render(<AuditedPlanReviewPanel task={task()} />)
    expect(screen.getByRole('button', { name: 'Run Codex Audit' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Approve for Implementation' })).toBeNull()
  })

  it('labels the original plan', () => {
    render(<AuditedPlanReviewPanel task={task()} />)
    expect(screen.getByText('Original plan')).toBeInTheDocument()
  })

  it('disables the audit when the artifact is unavailable', () => {
    render(
      <AuditedPlanReviewPanel task={task({ planArtifactAvailable: false, planArtifactId: null })} />
    )
    expect(screen.getByRole('button', { name: 'Run Codex Audit' })).toBeDisabled()
    expect(screen.getByText('The plan could not be loaded.')).toBeInTheDocument()
  })
})

describe('running review', () => {
  it('shows a busy primary and a Cancel', () => {
    render(<AuditedPlanReviewPanel task={task({ planReviewRunStatus: 'running' })} />)
    expect(screen.getByRole('button', { name: 'Codex is reviewing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })
})

describe('approved verdict', () => {
  const approved = task({
    planReviewRunStatus: 'succeeded',
    planReviewVerdict: 'approved',
    planReviewSummary: 'The plan is sound.',
    planApprovalReady: true
  })

  it('renders the verdict as "Accepted" while the durable value stays approved', () => {
    render(<AuditedPlanReviewPanel task={approved} />)
    expect(screen.getByText('Accepted')).toBeInTheDocument()
  })

  it('offers Approve and NOT Request Revision', () => {
    render(<AuditedPlanReviewPanel task={approved} />)
    expect(screen.getByRole('button', { name: 'Approve for Implementation' })).toBeEnabled()
    // No legal transition from awaiting_plan_review back to revision exists.
    expect(screen.queryByRole('button', { name: /Revision/i })).toBeNull()
  })

  it('shows the reviewer summary', () => {
    render(<AuditedPlanReviewPanel task={approved} />)
    expect(screen.getByText('The plan is sound.')).toBeInTheDocument()
  })

  it('calls approve on click', async () => {
    render(<AuditedPlanReviewPanel task={approved} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve for Implementation' }))
    expect(mocks.storeState.approveAuditedPlan).toHaveBeenCalledWith('audited_1')
  })

  // The renderer must never manufacture the approve affordance itself.
  it('does NOT offer Approve when the server says it is not ready', () => {
    render(
      <AuditedPlanReviewPanel
        task={task({
          planReviewRunStatus: 'succeeded',
          planReviewVerdict: 'approved',
          planApprovalReady: false
        })}
      />
    )
    expect(screen.queryByRole('button', { name: 'Approve for Implementation' })).toBeNull()
  })

  it('surfaces a refused approval as a closed message', async () => {
    mocks.storeState.approveAuditedPlan = vi
      .fn()
      .mockResolvedValue({ ok: false, reasonCode: 'artifact_superseded' })
    render(<AuditedPlanReviewPanel task={approved} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve for Implementation' }))
    expect(
      await screen.findByText('The plan changed since it was reviewed. Run the review again.')
    ).toBeInTheDocument()
  })
})

describe('fixes_requested verdict', () => {
  const fixes = task({
    state: 'plan_fixes_requested',
    planReviewRunStatus: 'succeeded',
    planReviewVerdict: 'fixes_requested',
    planReviewSummary: 'Two gaps.',
    planReviewFindingCount: 2,
    planRevisionAvailable: true
  })

  it('renders the verdict as "Changes requested"', () => {
    render(<AuditedPlanReviewPanel task={fixes} />)
    expect(screen.getByText('Changes requested')).toBeInTheDocument()
  })

  it('offers Revise Plan and no Approve', () => {
    render(<AuditedPlanReviewPanel task={fixes} />)
    expect(screen.getByRole('button', { name: 'Revise Plan' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Approve for Implementation' })).toBeNull()
  })

  it('shows the finding count', () => {
    render(<AuditedPlanReviewPanel task={fixes} />)
    expect(screen.getByText('2 findings.')).toBeInTheDocument()
  })

  it('disables Revise Plan at the round cap and says why', () => {
    render(
      <AuditedPlanReviewPanel task={{ ...fixes, planRound: 3, planRevisionAvailable: false }} />
    )
    expect(screen.getByRole('button', { name: 'Revise Plan' })).toBeDisabled()
    expect(screen.getByText('The revision limit has been reached.')).toBeInTheDocument()
  })

  it('labels the current round', () => {
    render(<AuditedPlanReviewPanel task={{ ...fixes, planRound: 2 }} />)
    expect(screen.getByText('Plan round 2 of 3')).toBeInTheDocument()
  })
})

describe('review failures', () => {
  it('offers Retry Audit for a retryable failure', () => {
    render(
      <AuditedPlanReviewPanel
        task={task({ planReviewRunStatus: 'failed', planReviewReasonCode: 'timeout' })}
      />
    )
    expect(
      screen.getByText('The review timed out and was stopped. You can retry.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry Audit' })).toBeEnabled()
  })

  it('offers NO retry for an unparseable verdict', () => {
    render(
      <AuditedPlanReviewPanel
        task={task({
          planReviewRunStatus: 'failed',
          planReviewReasonCode: 'verdict_unparseable'
        })}
      />
    )
    expect(
      screen.getByText('Codex did not return a usable verdict, so the plan was not accepted.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry Audit' })).toBeNull()
  })

  it('offers Retry Audit after a restart-recovered interruption', () => {
    render(
      <AuditedPlanReviewPanel
        task={task({ planReviewRunStatus: 'interrupted', planReviewReasonCode: 'interrupted' })}
      />
    )
    expect(
      screen.getByText('The review was interrupted before it finished. You can retry.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry Audit' })).toBeEnabled()
  })

  it('reports a superseded result without offering a retry', () => {
    render(
      <AuditedPlanReviewPanel
        task={task({
          planReviewRunStatus: 'failed',
          planReviewReasonCode: 'artifact_superseded'
        })}
      />
    )
    expect(
      screen.getByText(
        'The plan changed while the review was running, so the result was discarded.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry Audit' })).toBeNull()
  })
})

describe('blocked verdict', () => {
  it('offers neither Approve nor Revise Plan', () => {
    render(
      <AuditedPlanReviewPanel
        task={task({
          state: 'awaiting_plan_review',
          planReviewRunStatus: 'succeeded',
          planReviewVerdict: 'blocked',
          planReviewSummary: 'Fundamentally unsafe.'
        })}
      />
    )
    expect(screen.getByText('Blocked')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve for Implementation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revise Plan' })).toBeNull()
  })
})
