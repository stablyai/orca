// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitHistoryResult } from '../../../../../../shared/git-history'
import { buildGitHistoryViewModels } from '../../../../../../shared/git-history-graph'
import { GitHistoryList, type GitHistoryListActions } from './git-history-list'

afterEach(cleanup)

function history(): GitHistoryResult {
  return {
    items: [{ id: 'a', parentIds: ['b'], subject: 'First commit', message: 'First commit' }],
    limit: 50,
    hasMore: true,
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    nextCursor: { revisions: ['a'.repeat(40)], offset: 1 }
  }
}

function list(result: GitHistoryResult, actions: GitHistoryListActions = {}, extra = {}) {
  return (
    <TooltipProvider>
      <GitHistoryList
        result={result}
        viewModels={buildGitHistoryViewModels(result.items)}
        height="256px"
        refreshing={false}
        {...actions}
        {...extra}
      />
    </TooltipProvider>
  )
}

describe('GitHistoryList paging', () => {
  it('retains expanded commit files and scroll position when appending a page', async () => {
    const result = history()
    const actions = { onLoadCommitFiles: vi.fn().mockResolvedValue([]), onOpenCommitFile: vi.fn() }
    const view = render(list(result, actions))
    await act(async () => {
      fireEvent.click(screen.getByTestId('git-history-row'))
    })
    expect(screen.getByTestId('git-history-row').getAttribute('aria-expanded')).toBe('true')
    const scroller = screen.getByLabelText('Commit history')
    scroller.scrollTop = 100
    view.rerender(
      list(
        {
          ...result,
          items: [
            ...result.items,
            { id: 'b', parentIds: [], subject: 'Older commit', message: 'Older commit' }
          ]
        },
        actions
      )
    )
    expect(screen.getAllByTestId('git-history-row')[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(scroller.scrollTop).toBe(100)
    expect(actions.onLoadCommitFiles).toHaveBeenCalledTimes(1)
  })

  it('shows a retry without hiding existing commits and pauses automatic loading', () => {
    const onLoadMore = vi.fn()
    render(list(history(), { onLoadMore }, { loadMoreError: 'Network disconnected' }))
    expect(screen.getByRole('alert').textContent).toBe('Network disconnected')
    expect(screen.getByText('First commit')).toBeTruthy()
    expect(onLoadMore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading commits' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('announces loading and completion, and explains old-host pagination limits', () => {
    const result = history()
    const view = render(list(result, {}, { isLoadingMore: true }))
    expect(screen.getByRole('status').textContent).toContain('Loading more commits')
    view.rerender(list({ ...result, nextCursor: undefined }))
    expect(
      screen.getByText('Restart Orca or update the execution host to load older commits.')
    ).toBeTruthy()
    view.rerender(list({ ...result, hasMore: false, nextCursor: undefined }))
    expect(screen.getByText('All commits loaded')).toBeTruthy()
  })
})
