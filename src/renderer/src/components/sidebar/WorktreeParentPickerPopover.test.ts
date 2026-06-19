import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import {
  getWorktreeParentPickerItemValue,
  selectWorktreeParent
} from './WorktreeParentPickerPopover'

afterEach(() => {
  vi.restoreAllMocks()
})

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo::/workspaces/parent',
    instanceId: 'parent-instance',
    repoId: 'repo',
    path: '/workspaces/parent',
    head: 'abc',
    branch: 'refs/heads/feature/parent',
    isBare: false,
    isMainWorktree: false,
    isSparse: false,
    displayName: 'Parent Worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('selectWorktreeParent', () => {
  it('closes and assigns the selected parent to the captured child', () => {
    const assignWorktreeParent = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn()
    const showError = vi.fn()

    selectWorktreeParent({
      childWorktreeId: 'child',
      parentWorktreeId: 'parent',
      assignWorktreeParent,
      close,
      showError
    })

    expect(close).toHaveBeenCalledTimes(1)
    expect(assignWorktreeParent).toHaveBeenCalledWith('child', { parentWorktreeId: 'parent' })
    expect(showError).not.toHaveBeenCalled()
  })

  it('shows sanitized failure copy after closing the picker', async () => {
    const assignWorktreeParent = vi.fn().mockRejectedValue(new Error('stale parent'))
    const close = vi.fn()
    const showError = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    selectWorktreeParent({
      childWorktreeId: 'child',
      parentWorktreeId: 'parent',
      assignWorktreeParent,
      close,
      showError
    })
    await Promise.resolve()

    expect(close).toHaveBeenCalledTimes(1)
    expect(showError).toHaveBeenCalledWith('Failed to set parent worktree')
  })

  it('does nothing without a captured child id', () => {
    const assignWorktreeParent = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn()

    selectWorktreeParent({
      childWorktreeId: null,
      parentWorktreeId: 'parent',
      assignWorktreeParent,
      close,
      showError: vi.fn()
    })

    expect(close).not.toHaveBeenCalled()
    expect(assignWorktreeParent).not.toHaveBeenCalled()
  })
})

describe('getWorktreeParentPickerItemValue', () => {
  it('includes workspace-facing fields used by command filtering', () => {
    expect(getWorktreeParentPickerItemValue(makeWorktree())).toContain('Parent Worktree')
    expect(getWorktreeParentPickerItemValue(makeWorktree())).toContain('feature/parent')
    expect(getWorktreeParentPickerItemValue(makeWorktree())).toContain('/workspaces/parent')
  })
})
