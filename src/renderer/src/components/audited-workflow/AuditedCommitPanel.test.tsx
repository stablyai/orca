// @vitest-environment happy-dom

// Phase 8 commit panel: server-computed gating and the advisory-vs-failure split.
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'

const storeState = {
  approveAuditedCommit: vi.fn(),
  revokeAuditedApproval: vi.fn(),
  commitAuditedTask: vi.fn(),
  auditedCommitPendingTaskId: null
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { AuditedCommitPanel } from './AuditedCommitPanel'

afterEach(cleanup)

function task(overrides: Partial<AuditedTaskStatusProjection> = {}): AuditedTaskStatusProjection {
  return {
    taskId: 'task1',
    repoId: 'repo1',
    title: 'Do the thing',
    state: 'awaiting_human_approval',
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
    coverageAvailable: false,
    candidateAvailable: true,
    codeAuditRunStatus: null,
    codeAuditVerdict: null,
    codeAuditReasonCode: null,
    codeAuditSummary: null,
    codeAuditFindingCount: null,
    codeFixAvailable: false,
    acceptanceCriteria: [],
    timings: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('AuditedCommitPanel', () => {
  it.each(['selected', 'planning', 'implementing', 'awaiting_code_audit', 'blocked'] as const)(
    'renders nothing in %s',
    (state) => {
      const { container } = render(<AuditedCommitPanel task={task({ state })} />)
      expect(container).toBeEmptyDOMElement()
    }
  )

  it('offers no approve affordance until the code review approved', () => {
    render(<AuditedCommitPanel task={task({ commitApprovalReady: false })} />)
    expect(screen.getByText(/code review has not approved/i)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers Approve once the server says the review approved', () => {
    render(<AuditedCommitPanel task={task({ commitApprovalReady: true })} />)
    expect(screen.getByRole('button', { name: /approve for commit/i })).toBeInTheDocument()
  })

  it('offers Commit only when the server says commitReady', () => {
    render(
      <AuditedCommitPanel
        task={task({ commitApprovalReady: true, commitReady: true, approvalState: 'pending' })}
      />
    )
    expect(screen.getByRole('button', { name: /^commit$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /revoke approval/i })).toBeInTheDocument()
  })

  it('withdraws the commit affordance when the approval expired', () => {
    render(
      <AuditedCommitPanel
        task={task({ commitApprovalReady: true, commitReady: false, approvalState: 'expired' })}
      />
    )
    expect(screen.queryByRole('button', { name: /^commit$/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /approve for commit/i })).toBeInTheDocument()
  })

  // The advisory renders NEXT TO a successful commit, never in place of it.
  it('shows the short SHA and a drift advisory together when committed', () => {
    render(
      <AuditedCommitPanel
        task={task({
          state: 'committed',
          committedShaShort: 'abc123def456',
          commitAdvisoryCode: 'post_commit_drift_detected'
        })}
      />
    )
    expect(screen.getByText(/abc123def456/)).toBeInTheDocument()
    expect(screen.getByText(/changes made after the commit/i)).toBeInTheDocument()
    // Crucially, it is not presented as a failure.
    expect(screen.queryByText(/nothing was committed/i)).not.toBeInTheDocument()
  })

  it('shows a plain committed summary with no advisory', () => {
    render(
      <AuditedCommitPanel task={task({ state: 'committed', committedShaShort: 'abc123def456' })} />
    )
    expect(screen.getByText(/abc123def456/)).toBeInTheDocument()
    expect(screen.queryByText(/after the commit/i)).not.toBeInTheDocument()
  })
})
