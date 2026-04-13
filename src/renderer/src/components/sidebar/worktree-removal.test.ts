import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { getWorktreeRemovalAction, openWorktreeRemovalModal } from './worktree-removal'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/tmp/feature-123',
    repoId: 'repo-1',
    path: '/tmp/feature-123',
    head: 'abc123',
    branch: 'refs/heads/feature-123',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature-123',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    isArchived: false,
    isUnread: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('getWorktreeRemovalAction', () => {
  it('uses delete worktree copy for normal git worktrees', () => {
    expect(getWorktreeRemovalAction(makeWorktree(), false)).toEqual({
      disabled: false,
      label: 'Delete worktree'
    })
  })

  it('uses folder removal copy for folder rows', () => {
    expect(getWorktreeRemovalAction(makeWorktree(), true)).toEqual({
      disabled: false,
      label: 'Remove folder from Orca'
    })
  })

  it('disables deletion for the main worktree', () => {
    expect(getWorktreeRemovalAction(makeWorktree({ isMainWorktree: true }), false)).toEqual({
      disabled: true,
      disabledReason: 'The main worktree cannot be deleted',
      label: 'Delete worktree'
    })
  })
})

describe('openWorktreeRemovalModal', () => {
  it('opens the delete worktree modal for git worktrees after clearing stale state', () => {
    const clearWorktreeDeleteState = vi.fn()
    const openModal = vi.fn()
    const worktree = makeWorktree()

    openWorktreeRemovalModal(worktree, false, openModal, clearWorktreeDeleteState)

    expect(clearWorktreeDeleteState).toHaveBeenCalledWith(worktree.id)
    expect(openModal).toHaveBeenCalledWith('delete-worktree', { worktreeId: worktree.id })
  })

  it('opens the folder removal modal without clearing git delete state', () => {
    const clearWorktreeDeleteState = vi.fn()
    const openModal = vi.fn()
    const worktree = makeWorktree({ displayName: 'workspace-folder' })

    openWorktreeRemovalModal(worktree, true, openModal, clearWorktreeDeleteState)

    expect(clearWorktreeDeleteState).not.toHaveBeenCalled()
    expect(openModal).toHaveBeenCalledWith('confirm-remove-folder', {
      repoId: worktree.repoId,
      displayName: worktree.displayName
    })
  })

  it('does not open any modal for the main worktree', () => {
    const clearWorktreeDeleteState = vi.fn()
    const openModal = vi.fn()
    const worktree = makeWorktree({ isMainWorktree: true })

    openWorktreeRemovalModal(worktree, false, openModal, clearWorktreeDeleteState)

    expect(clearWorktreeDeleteState).not.toHaveBeenCalled()
    expect(openModal).not.toHaveBeenCalled()
  })
})
