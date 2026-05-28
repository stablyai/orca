import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import {
  finalizeImportedRepoAfterSkip,
  type AddRepoSkipFinalizationState
} from './add-repo-skip-finalization'

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: `/tmp/${overrides.id}`,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeState(overrides: Partial<AddRepoSkipFinalizationState>): AddRepoSkipFinalizationState {
  return {
    activeRepoId: null,
    filterRepoIds: [],
    showActiveOnly: false,
    hideDefaultBranchWorkspace: false,
    worktreesByRepo: {},
    setActiveRepo: vi.fn(),
    setFilterRepoIds: vi.fn(),
    setShowActiveOnly: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    ...overrides
  }
}

describe('finalizeImportedRepoAfterSkip', () => {
  it('keeps skipped imported worktrees visible without activating a worktree', () => {
    const state = makeState({
      activeRepoId: 'repo-old',
      filterRepoIds: ['repo-old'],
      showActiveOnly: true,
      hideDefaultBranchWorkspace: false,
      worktreesByRepo: {
        'repo-new': [makeWorktree({ id: 'repo-new::/repo/feature', repoId: 'repo-new' })]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setActiveRepo).toHaveBeenCalledWith('repo-new')
    expect(state.setFilterRepoIds).toHaveBeenCalledWith([])
    expect(state.setShowActiveOnly).toHaveBeenCalledWith(false)
    expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
  })

  it('clears default-branch hiding when it would hide every imported worktree', () => {
    const state = makeState({
      hideDefaultBranchWorkspace: true,
      worktreesByRepo: {
        'repo-new': [
          makeWorktree({
            id: 'repo-new::/repo/main',
            repoId: 'repo-new',
            isMainWorktree: true,
            branch: 'refs/heads/main'
          })
        ]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setHideDefaultBranchWorkspace).toHaveBeenCalledWith(false)
  })

  it('does nothing when the imported repo has no discovered worktrees yet', () => {
    const state = makeState({
      activeRepoId: 'repo-old',
      filterRepoIds: ['repo-old'],
      showActiveOnly: true,
      hideDefaultBranchWorkspace: true,
      worktreesByRepo: { 'repo-new': [] }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setActiveRepo).not.toHaveBeenCalled()
    expect(state.setFilterRepoIds).not.toHaveBeenCalled()
    expect(state.setShowActiveOnly).not.toHaveBeenCalled()
    expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
  })
})
