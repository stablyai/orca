// @vitest-environment happy-dom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceControlContentStatus } from './source-control/listing/content-status'
import { TooManyChangesBanner } from './source-control/listing/too-many-changes-banner'

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

describe('TooManyChangesBanner', () => {
  beforeEach(() => {
    toastErrorMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts stale retry work when the banner unmounts', async () => {
    let retrySignal: AbortSignal | undefined
    const onRetry = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          retrySignal = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const view = render(<TooManyChangesBanner limit={1_000} onRetry={onRetry} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(retrySignal?.aborted).toBe(false)

    view.unmount()

    await waitFor(() => expect(retrySignal?.aborted).toBe(true))
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('bounds a hung retry and restores the action', async () => {
    vi.useFakeTimers()
    const onRetry = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    render(<TooManyChangesBanner limit={1_000} onRetry={onRetry} />)

    const retryButton = screen.getByRole('button', { name: 'Retry' })
    fireEvent.click(retryButton)
    expect((retryButton as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })

    expect((retryButton as HTMLButtonElement).disabled).toBe(false)
    expect(toastErrorMock).toHaveBeenCalledWith('Could not refresh Source Control. Try again.')
  })

  it('offers a whole-worktree Stage All while the listing is capped', () => {
    // Why: once the capped prefix is all staged, no section or primary Stage All can reach the rest.
    const onStageAllChanges = vi.fn().mockResolvedValue(undefined)
    const props = {
      unresolvedConflictCount: 0,
      conflictOperation: 'unknown' as const,
      sourceControlAiActionsVisible: false,
      isAbortingOperation: false,
      onAbortOperation: vi.fn(),
      onResolveWithAi: vi.fn(),
      onReviewConflicts: vi.fn(),
      worktreeId: 'wt-1',
      onRetryStatus: vi.fn().mockResolvedValue(undefined),
      onStageAllChanges,
      showGenericEmptyState: false,
      normalizedFilter: '',
      branchBaseRef: null,
      filterTooLarge: false,
      hasFilteredUncommittedEntries: true,
      hasFilteredBranchEntries: false,
      filterQuery: ''
    }
    const view = render(
      <SourceControlContentStatus
        {...props}
        repositoryHuge={{ limit: 1_000 }}
        isExecutingBulk={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stage All' }))
    expect(onStageAllChanges).toHaveBeenCalledTimes(1)

    view.rerender(
      <SourceControlContentStatus {...props} repositoryHuge={{ limit: 1_000 }} isExecutingBulk />
    )
    expect(screen.getByRole('button', { name: 'Stage All' }).hasAttribute('disabled')).toBe(true)

    view.rerender(
      <SourceControlContentStatus {...props} repositoryHuge={undefined} isExecutingBulk={false} />
    )
    expect(screen.queryByRole('button', { name: 'Stage All' })).toBeNull()
  })
})
