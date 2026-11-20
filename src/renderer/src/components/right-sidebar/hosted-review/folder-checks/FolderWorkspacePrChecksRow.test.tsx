// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { FolderWorkspacePrChecksRow } from './FolderWorkspacePrChecksRow'
import type { ParentPrChecksRow } from './parent-pr-checks-row-types'

afterEach(cleanup)

it('opens the workspace from the row without expanding its inline details', () => {
  const row: ParentPrChecksRow = {
    id: 'child',
    refreshIdentity: 'child',
    worktree: makeWorktree({ id: 'repo::/checkout', repoId: 'repo', displayName: 'Child' }),
    repo: null,
    branch: null,
    status: 'noReview',
    group: 'noPr',
    checkTone: 'neutral',
    title: 'No pull request',
    reviewNumber: null,
    reviewLabel: null,
    reviewUrl: null,
    reviewState: null,
    reviewStatus: null,
    provider: null,
    summary: 'No checks',
    detailNames: [],
    checks: [],
    isRefreshing: false,
    hasLinkedReview: false
  }
  const onOpen = vi.fn()
  const onToggle = vi.fn()
  render(
    <FolderWorkspacePrChecksRow
      row={row}
      expanded={false}
      onOpen={onOpen}
      onToggle={onToggle}
      onLoadCheckDetails={async () => null}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: /^Child/ }))
  expect(onOpen).toHaveBeenCalledOnce()
  expect(onToggle).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  expect(onToggle).toHaveBeenCalledOnce()
  expect(onOpen).toHaveBeenCalledOnce()
})
