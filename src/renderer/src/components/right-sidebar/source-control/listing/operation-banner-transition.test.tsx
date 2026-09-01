// @vitest-environment happy-dom

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GitOperationProgress } from '../../../../../../shared/git-status-types'
import { SourceControlContentStatus } from './content-status'

const progress: GitOperationProgress = {
  headName: 'triage-e2e',
  onto: 'origin/main',
  currentStep: 3,
  totalSteps: 7,
  commitSubject: 'ci: split the e2e shards',
  stoppedBy: 'pick'
}

function baseProps(unresolvedConflictCount: number) {
  return {
    unresolvedConflictCount,
    conflictOperation: 'rebase' as const,
    sourceControlAiActionsVisible: true,
    isAbortingOperation: false,
    isAdvancingOperation: false,
    operationProgress: progress,
    onAbortOperation: vi.fn(),
    onContinueOperation: vi.fn(),
    onResolveWithAi: vi.fn(),
    onReviewConflicts: vi.fn(),
    repositoryHuge: null,
    worktreeId: 'wt-1',
    onRetryStatus: vi.fn(async () => {}),
    showGenericEmptyState: false,
    normalizedFilter: '',
    branchBaseRef: 'origin/main',
    filterTooLarge: false,
    hasFilteredUncommittedEntries: true,
    hasFilteredBranchEntries: false,
    filterQuery: ''
  }
}

describe('banner swap when continue lands in a new conflict', () => {
  it('keeps the card container mounted in place while the contents change', () => {
    // Resolved-and-ready: the OperationBanner is showing.
    const { container, rerender } = render(<SourceControlContentStatus {...baseProps(0)} />)
    const cardBefore = container.querySelector('[data-testid="source-control-operation-card"]')
    expect(cardBefore).not.toBeNull()
    expect(container.textContent).toContain('Rebasing onto origin/main')
    expect(container.textContent).toContain('Continue rebase')

    // `git rebase --continue` advanced into a NEW conflict on the next step.
    rerender(
      <SourceControlContentStatus
        {...baseProps(2)}
        operationProgress={{ ...progress, currentStep: 4 }}
      />
    )

    const cardAfter = container.querySelector('[data-testid="source-control-operation-card"]')
    // Same DOM node: the panel does not unmount and remount the box under the user.
    expect(cardAfter).toBe(cardBefore)
    expect(container.textContent).toContain('Rebase conflicts: 2 unresolved')
    expect(container.textContent).toContain('Review conflicts')
  })

  it('keeps the container mounted when the operation finishes and the card leaves', () => {
    const { container, rerender } = render(<SourceControlContentStatus {...baseProps(0)} />)
    expect(container.querySelector('[data-testid="source-control-operation-card"]')).not.toBeNull()

    rerender(
      <SourceControlContentStatus
        {...baseProps(0)}
        conflictOperation="unknown"
        operationProgress={null}
      />
    )

    expect(container.querySelector('[data-testid="source-control-operation-card"]')).toBeNull()
  })

  it('swaps back from conflicts to the in-progress banner on the same node', () => {
    const { container, rerender } = render(<SourceControlContentStatus {...baseProps(1)} />)
    const cardBefore = container.querySelector('[data-testid="source-control-operation-card"]')

    rerender(<SourceControlContentStatus {...baseProps(0)} />)

    expect(container.querySelector('[data-testid="source-control-operation-card"]')).toBe(
      cardBefore
    )
    expect(container.textContent).toContain('Continue rebase')
  })
})
