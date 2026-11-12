import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
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
    showSleepingWorkspaces: true,
    alwaysShowDefaultBranchWorkspace: true,
    repos: [],
    worktreesByRepo: {},
    setActiveRepo: vi.fn(),
    setFilterRepoIds: vi.fn(),
    setShowActiveOnly: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    setAlwaysShowDefaultBranchWorkspace: vi.fn(),
    ...overrides
  }
}

describe('finalizeImportedRepoAfterSkip', () => {
  it('preserves default-branch hiding when importing a folder project with only its root', () => {
    const state = makeState({
      hideDefaultBranchWorkspace: true,
      repos: [{ id: 'folder-new', kind: 'folder' }],
      worktreesByRepo: {
        'folder-new': [
          makeWorktree({
            id: 'folder-new::/notes',
            repoId: 'folder-new',
            isMainWorktree: true,
            head: '',
            branch: ''
          })
        ]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'folder-new')

    expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'ignores archived siblings when revealing a folder root after Skip (root archived: %s)',
    (rootArchived) => {
      const state = makeState({
        hideDefaultBranchWorkspace: true,
        showSleepingWorkspaces: false,
        alwaysShowDefaultBranchWorkspace: false,
        repos: [{ id: 'folder-new', kind: 'folder' }],
        worktreesByRepo: {
          'folder-new': [
            makeWorktree({
              id: 'folder-new::/notes',
              repoId: 'folder-new',
              isMainWorktree: true,
              head: '',
              branch: '',
              isArchived: rootArchived
            }),
            makeWorktree({
              id: 'folder-new::/notes::workspace:archived',
              repoId: 'folder-new',
              head: '',
              branch: '',
              isArchived: true
            })
          ]
        }
      })

      finalizeImportedRepoAfterSkip(state, 'folder-new')

      if (rootArchived) {
        expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
        expect(state.setAlwaysShowDefaultBranchWorkspace).not.toHaveBeenCalled()
      } else {
        expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
        expect(state.setAlwaysShowDefaultBranchWorkspace).toHaveBeenCalledWith(true)
      }
    }
  )

  it('re-enables the default-branch exemption when the import would land asleep and hidden', () => {
    const state = makeState({
      showSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: false,
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

    expect(state.setAlwaysShowDefaultBranchWorkspace).toHaveBeenCalledWith(true)
  })
})
