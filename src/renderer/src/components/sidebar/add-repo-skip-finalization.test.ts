import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
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

// Why keep a setter the contract dropped: a ratchet against re-introducing the filter
// flip that silently overrode the user's "Hide default branch" choice.
type SkipFinalizationTestState = AddRepoSkipFinalizationState & {
  setHideDefaultBranchWorkspace: ReturnType<typeof vi.fn>
}

function makeState(overrides: Partial<SkipFinalizationTestState>): SkipFinalizationTestState {
  return {
    activeRepoId: null,
    filterRepoIds: [],
    showActiveOnly: false,
    hideDefaultBranchWorkspace: false,
    showSleepingWorkspaces: true,
    alwaysShowDefaultBranchWorkspace: true,
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

  it('keeps default-branch hiding on when the import is only a default checkout', () => {
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

    expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
    expect(state.setActiveRepo).toHaveBeenCalledWith('repo-new')
  })

  it('leaves the sleeping exemption alone when Hide default branch already hides the import', () => {
    const state = makeState({
      showSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: false,
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

    expect(state.setAlwaysShowDefaultBranchWorkspace).not.toHaveBeenCalled()
  })

  it('still exempts a branchless main import from the sleeping sweep while Hide default branch is on', () => {
    // Why: the filter only hides rows that pass isDefaultBranchWorkspace, so a
    // detached-HEAD main is not hidden by it and still needs the sweep exemption.
    const state = makeState({
      showSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: false,
      hideDefaultBranchWorkspace: true,
      worktreesByRepo: {
        'repo-new': [
          makeWorktree({
            id: 'repo-new::/repo/main',
            repoId: 'repo-new',
            isMainWorktree: true,
            branch: ''
          })
        ]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setAlwaysShowDefaultBranchWorkspace).toHaveBeenCalledWith(true)
  })

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

  it('leaves the default-branch exemption alone when sleeping workspaces are shown', () => {
    const state = makeState({
      showSleepingWorkspaces: true,
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

    expect(state.setAlwaysShowDefaultBranchWorkspace).not.toHaveBeenCalled()
  })

  it('still reveals the imported repo when it has no discovered worktrees yet', () => {
    const state = makeState({
      activeRepoId: 'repo-old',
      filterRepoIds: ['repo-old'],
      showActiveOnly: true,
      hideDefaultBranchWorkspace: true,
      worktreesByRepo: { 'repo-new': [] }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setActiveRepo).toHaveBeenCalledWith('repo-new')
    expect(state.setFilterRepoIds).toHaveBeenCalledWith([])
    expect(state.setShowActiveOnly).toHaveBeenCalledWith(false)
    expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
  })
})
