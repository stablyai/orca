// @vitest-environment happy-dom

// The UI must never present a no-tools audit as a full Codex audit.
//
// This is a HONESTY assertion, not a styling one: a user deciding whether to
// trust an "approved" verdict needs to see which transport produced it, and the
// weaker one has to be visibly marked.
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUDIT_MODE_LABELS } from '../../../../shared/audited-audit-mode-types'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'
import { AuditedCodeAuditPanel } from './AuditedCodeAuditPanel'
import { getPlanReviewVerdictLabel } from './audited-plan-review-labels'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      startAuditedCodeAudit: vi.fn(),
      cancelAuditedCodeAudit: vi.fn(),
      retryAuditedCodeAudit: vi.fn(),
      requestAuditedCodeFix: vi.fn()
    })
}))

function task(overrides: Partial<AuditedTaskStatusProjection>): AuditedTaskStatusProjection {
  return {
    ...(BASE as unknown as AuditedTaskStatusProjection),
    ...overrides
  }
}

afterEach(() => {
  cleanup()
})

describe('the audit mode is visible beside the verdict', () => {
  it('labels a no-tools audit explicitly', () => {
    render(
      <AuditedCodeAuditPanel
        task={task({
          state: 'awaiting_code_audit',
          codeAuditMode: 'byesu_no_tools',
          codeAuditVerdict: 'approved',
          codeAuditRunStatus: 'succeeded'
        })}
      />
    )

    expect(screen.getByText(AUDIT_MODE_LABELS.byesu_no_tools)).toBeInTheDocument()
    expect(screen.getByText('Byesu (no-tools)')).toBeInTheDocument()
  })

  it('never claims a no-tools audit was a Codex CLI audit', () => {
    const { container } = render(
      <AuditedCodeAuditPanel
        task={task({
          state: 'awaiting_code_audit',
          codeAuditMode: 'byesu_no_tools',
          codeAuditVerdict: 'approved',
          codeAuditRunStatus: 'succeeded'
        })}
      />
    )

    // The stronger claim must not appear anywhere in the rendered output.
    expect(container.textContent).not.toContain('Codex CLI')
    expect(container.textContent).not.toContain(AUDIT_MODE_LABELS.codex_cli)
  })

  it('leaves a real Codex CLI audit unbadged', () => {
    render(
      <AuditedCodeAuditPanel
        task={task({
          state: 'awaiting_code_audit',
          codeAuditMode: 'codex_cli',
          codeAuditVerdict: 'approved',
          codeAuditRunStatus: 'succeeded'
        })}
      />
    )

    // The full-strength default carries no badge, so the no-tools marker reads
    // as a caveat rather than as one neutral variant among two.
    expect(screen.queryByText(AUDIT_MODE_LABELS.byesu_no_tools)).not.toBeInTheDocument()
    // Asserted through the label function rather than a literal, so a wording
    // change cannot silently turn this into a test of nothing.
    expect(screen.getByText(getPlanReviewVerdictLabel('approved'))).toBeInTheDocument()
  })

  it('shows no mode badge before any audit has run', () => {
    render(
      <AuditedCodeAuditPanel task={task({ state: 'awaiting_code_audit', codeAuditMode: null })} />
    )
    expect(screen.queryByText(AUDIT_MODE_LABELS.byesu_no_tools)).not.toBeInTheDocument()
  })
})

const BASE = {
  taskId: 'audited_abc123',
  repoId: 'repo1',
  title: 'A task',
  state: 'awaiting_code_audit',
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
  approvalState: null,
  approvedCandidateIdShort: null,
  reconcileClass: null,
  reconcileReasonCode: null,
  worktreeBranch: null,
  worktreeReasonCode: null,
  worktreeProvenance: null,
  worktreeVerifiedAt: null,
  executionRunStatus: null,
  executionReasonCode: null,
  executionMode: null,
  planArtifactId: null,
  planArtifactStatus: null,
  planArtifactCharCount: null,
  planArtifactTruncated: false,
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
  codeAuditMode: null,
  codeAuditSummary: null,
  codeAuditFindingCount: null,
  codeFixAvailable: false,
  fixRoundLimit: 3,
  acceptanceCriteria: [],
  timings: [],
  createdAt: 1,
  updatedAt: 1
}
