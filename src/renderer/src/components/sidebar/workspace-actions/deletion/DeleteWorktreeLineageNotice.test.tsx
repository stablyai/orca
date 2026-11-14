// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { DeleteWorktreeLineageNotice } from './DeleteWorktreeLineageNotice'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { projects: never[]; projectHostSetups: never[] }) => unknown) =>
    selector({ projects: [], projectHostSetups: [] })
}))

afterEach(cleanup)

it('lets a selected preserve option be cleared when it becomes unavailable, even with no children', () => {
  const onChange = vi.fn()
  const child: Worktree = {
    id: 'child',
    instanceId: 'child-instance',
    repoId: 'repo',
    path: '/parent/child',
    displayName: 'child',
    head: 'abc123',
    branch: 'child',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  const props = {
    descendants: [child],
    dirtyChangeCountsByWorktreeId: new Map(),
    dirtyChangePreviewsByWorktreeId: new Map(),
    preserveChildren: true,
    canPreserveChildren: false,
    disabled: false,
    onPreserveChildrenChange: onChange
  }
  const { rerender } = render(<DeleteWorktreeLineageNotice {...props} />)
  const checkbox = screen.getByRole('checkbox')
  expect(checkbox.hasAttribute('disabled')).toBe(false)
  fireEvent.click(checkbox)
  expect(onChange).toHaveBeenCalledWith(false)

  rerender(<DeleteWorktreeLineageNotice {...props} descendants={[]} />)
  fireEvent.click(screen.getByRole('checkbox'))
  expect(onChange).toHaveBeenCalledTimes(2)
  expect(onChange).toHaveBeenLastCalledWith(false)
})
