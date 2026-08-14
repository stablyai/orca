// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { GitHistoryResult } from '../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../shared/git-diff-compare-types'
import { GitHistoryPanel } from './GitHistoryPanel'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

afterEach(() => {
  cleanup()
})

const timestamp = new Date(2026, 5, 15, 12).getTime()

function commitId(index: number): string {
  return String(index + 1).padStart(40, 'a')
}

// `offset` shifts the commit ids so a later result can drop the originally expanded commit,
// which is what a base-ref change or branch switch does.
function makeHistoryResult(count: number, offset = 0): GitHistoryResult {
  const items = Array.from({ length: count }, (_, index) => {
    const id = commitId(index + offset)
    return {
      id,
      parentIds: index + 1 < count ? [commitId(index + 1 + offset)] : [],
      subject: `Commit ${index + 1 + offset}`,
      message: `Commit ${index + 1 + offset}`,
      displayId: id.slice(0, 7),
      author: 'Taylor',
      timestamp: timestamp - index * 60_000,
      references: []
    }
  })
  return {
    items,
    currentRef: {
      id: 'refs/heads/main',
      name: 'main',
      revision: items[0]?.id,
      category: 'branches'
    },
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: true,
    limit: count
  }
}

const fileEntries: GitBranchChangeEntry[] = [
  { path: 'src/app.ts', status: 'modified', added: 1, removed: 0 }
]

function renderPanel(
  result: GitHistoryResult,
  onLoadCommitFiles: () => Promise<GitBranchChangeEntry[]>,
  worktreeId = 'wt-a'
): React.JSX.Element {
  return (
    <GitHistoryPanel
      state={{ status: 'ready', result }}
      worktreeId={worktreeId}
      collapsed={false}
      onToggle={vi.fn()}
      onRefresh={vi.fn()}
      onLoadMore={vi.fn()}
      onOpenCommit={vi.fn()}
      onLoadCommitFiles={onLoadCommitFiles}
      onOpenCommitFile={vi.fn()}
    />
  )
}

function expandLabelFor(index: number): string {
  return `Show files in commit ${commitId(index).slice(0, 7)}: Commit ${index + 1}`
}

describe('GitHistoryPanel expansion persistence', () => {
  // Load more appends: the commits already on screen are the same commits, so collapsing them
  // (and dropping their file lists) destroys the inspection context the action exists to extend.
  it('keeps an expanded commit expanded, and its files cached, when Load more appends a page', async () => {
    const onLoadCommitFiles = vi.fn(async () => fileEntries)
    const view = render(renderPanel(makeHistoryResult(3), onLoadCommitFiles))

    fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
    expect(await screen.findByText('app.ts')).toBeTruthy()
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)

    view.rerender(renderPanel(makeHistoryResult(6), onLoadCommitFiles))

    await waitFor(() => {
      expect(screen.getAllByTestId('git-history-row')).toHaveLength(6)
    })
    expect(screen.getByText('app.ts')).toBeTruthy()
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)
  })

  // The other half of the prune: state for a commit the new result dropped must not survive,
  // so a later result that reintroduces the id refetches rather than showing a retained list.
  it('drops expansion and cached files for a commit the new result no longer contains', async () => {
    const onLoadCommitFiles = vi.fn(async () => fileEntries)
    const view = render(renderPanel(makeHistoryResult(3), onLoadCommitFiles))

    fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
    expect(await screen.findByText('app.ts')).toBeTruthy()

    view.rerender(renderPanel(makeHistoryResult(3, 10), onLoadCommitFiles))

    await waitFor(() => {
      expect(screen.queryByText('app.ts')).toBeNull()
    })

    view.rerender(renderPanel(makeHistoryResult(3), onLoadCommitFiles))
    fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
    expect(await screen.findByText('app.ts')).toBeTruthy()
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(2)
  })

  // Sibling worktrees of one repo share almost all history, so a commit can survive the switch.
  // useGitHistoryCommitActions drops its commit-compare cache per worktree, so a row retained
  // across the switch would look expanded while every file click resolved to nothing.
  it('drops expansion and cached files when the worktree changes, even if the commit survives', async () => {
    const onLoadCommitFiles = vi.fn(async () => fileEntries)
    const view = render(renderPanel(makeHistoryResult(3), onLoadCommitFiles, 'wt-a'))

    fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
    expect(await screen.findByText('app.ts')).toBeTruthy()
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)

    view.rerender(renderPanel(makeHistoryResult(3), onLoadCommitFiles, 'wt-b'))

    await waitFor(() => {
      expect(screen.queryByText('app.ts')).toBeNull()
    })

    // Re-expanding must refetch so the sibling commit-compare cache is repopulated.
    fireEvent.click(screen.getByRole('button', { name: expandLabelFor(0) }))
    expect(await screen.findByText('app.ts')).toBeTruthy()
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(2)
  })
})
