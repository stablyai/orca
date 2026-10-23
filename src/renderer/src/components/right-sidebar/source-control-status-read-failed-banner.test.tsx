// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SourceControlContentStatus } from './source-control/listing/content-status'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const props = {
  unresolvedConflictCount: 0,
  conflictOperation: 'unknown' as const,
  sourceControlAiActionsVisible: false,
  isAbortingOperation: false,
  onAbortOperation: vi.fn(),
  onResolveWithAi: vi.fn(),
  onReviewConflicts: vi.fn(),
  repositoryHuge: undefined,
  worktreeId: 'wt-1',
  onStageAllChanges: vi.fn().mockResolvedValue(undefined),
  isExecutingBulk: false,
  showGenericEmptyState: false,
  normalizedFilter: '',
  branchBaseRef: null,
  filterTooLarge: false,
  hasFilteredUncommittedEntries: false,
  hasFilteredBranchEntries: false,
  filterQuery: ''
}

it('shows Git’s error with a Retry while status cannot be read', () => {
  const onRetryStatus = vi.fn().mockResolvedValue(undefined)
  const view = render(
    <SourceControlContentStatus
      {...props}
      onRetryStatus={onRetryStatus}
      statusReadError="fatal: .git/index: index file smaller than expected"
    />
  )

  expect(screen.getByTestId('status-read-failed-banner').textContent).toContain(
    'fatal: .git/index: index file smaller than expected'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onRetryStatus).toHaveBeenCalledTimes(1)

  view.rerender(<SourceControlContentStatus {...props} onRetryStatus={onRetryStatus} />)
  expect(screen.queryByTestId('status-read-failed-banner')).toBeNull()
})
