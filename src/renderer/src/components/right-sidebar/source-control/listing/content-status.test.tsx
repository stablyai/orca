// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceControlContentStatus } from './content-status'

function statusProps(): React.ComponentProps<typeof SourceControlContentStatus> {
  return {
    unresolvedConflictCount: 0,
    conflictOperation: 'rebase',
    sourceControlAiActionsVisible: true,
    isRecoveryBusy: false,
    isAbortingOperation: false,
    onAbortOperation: vi.fn(),
    onResolveWithAi: vi.fn(),
    onReviewConflicts: vi.fn(),
    repositoryHuge: null,
    worktreeId: 'wt-1',
    onRetryStatus: vi.fn(),
    onStageAllChanges: vi.fn(),
    isExecutingBulk: false,
    showGenericEmptyState: false,
    normalizedFilter: '',
    branchBaseRef: 'main',
    filterTooLarge: false,
    hasFilteredUncommittedEntries: false,
    hasFilteredBranchEntries: false,
    filterQuery: ''
  }
}

afterEach(cleanup)

describe('SourceControlContentStatus recovery', () => {
  it.each(['merge', 'rebase', 'cherry-pick'] as const)(
    'wires the zero-conflict %s recovery button to the launch flow',
    (conflictOperation) => {
      const props = { ...statusProps(), conflictOperation }
      const view = render(<SourceControlContentStatus {...props} />)
      fireEvent.click(view.getByRole('button', { name: 'Resolve with AI' }))
      expect(props.onResolveWithAi).toHaveBeenCalledTimes(1)
    }
  )

  it.each([0, 1])(
    'blocks recovery while Git runs with %i unmerged paths',
    (unresolvedConflictCount) => {
      const props = { ...statusProps(), unresolvedConflictCount, isRecoveryBusy: true }
      const view = render(<SourceControlContentStatus {...props} />)
      const button = view.getByRole('button', { name: 'Resolve with AI' })
      expect(button.hasAttribute('disabled')).toBe(true)
      fireEvent.click(button)
      expect(props.onResolveWithAi).not.toHaveBeenCalled()

      view.rerender(<SourceControlContentStatus {...props} isRecoveryBusy={false} />)
      expect(button.hasAttribute('disabled')).toBe(false)
      fireEvent.click(button)
      expect(props.onResolveWithAi).toHaveBeenCalledTimes(1)
    }
  )

  it.each([0, 1])(
    'blocks recovery during abort with %i unmerged paths',
    (unresolvedConflictCount) => {
      const props = { ...statusProps(), unresolvedConflictCount, isAbortingOperation: true }
      const view = render(<SourceControlContentStatus {...props} />)
      const button = view.getByRole('button', { name: 'Resolve with AI' })
      fireEvent.click(button)
      expect(button.hasAttribute('disabled')).toBe(true)
      expect(props.onResolveWithAi).not.toHaveBeenCalled()
    }
  )

  it('hides recovery when AI is disabled', () => {
    const view = render(
      <SourceControlContentStatus {...statusProps()} sourceControlAiActionsVisible={false} />
    )
    expect(view.queryByRole('button', { name: 'Resolve with AI' })).toBeNull()
  })
})
