import type { Worktree } from '../../../../shared/types'
import { isDefaultBranchWorkspace } from './visible-worktrees'
import { revealRepoInProjectFilter } from './reveal-repo-in-project-filter'

export type AddRepoSkipFinalizationState = {
  activeRepoId: string | null
  filterRepoIds: string[]
  showActiveOnly: boolean
  hideDefaultBranchWorkspace: boolean
  showSleepingWorkspaces: boolean
  alwaysShowDefaultBranchWorkspace: boolean
  worktreesByRepo: Record<string, Worktree[]>
  setActiveRepo: (repoId: string | null) => void
  setFilterRepoIds: (repoIds: string[]) => void
  setShowActiveOnly: (value: boolean) => void
  setHideDefaultBranchWorkspace: (value: boolean) => void
  setAlwaysShowDefaultBranchWorkspace: (value: boolean) => void
}

export function finalizeImportedRepoAfterSkip(
  state: AddRepoSkipFinalizationState,
  importedRepoId: string
): void {
  const importedWorktrees = state.worktreesByRepo[importedRepoId] ?? []

  // Why: Skip means "do not open or create a worktree", not "hide the
  // imported project behind sidebar filters so it looks like nothing landed."
  if (state.activeRepoId !== importedRepoId) {
    state.setActiveRepo(importedRepoId)
  }
  // Why reveal-not-clear: adding the imported project to an active filter keeps
  // the user's other filtered projects selected instead of wiping the filter.
  const revealedFilter = revealRepoInProjectFilter(state.filterRepoIds, importedRepoId)
  if (revealedFilter) {
    state.setFilterRepoIds(revealedFilter)
  }
  if (state.showActiveOnly) {
    state.setShowActiveOnly(false)
  }
  if (
    importedWorktrees.length > 0 &&
    state.hideDefaultBranchWorkspace &&
    importedWorktrees.every((worktree) => isDefaultBranchWorkspace(worktree))
  ) {
    state.setHideDefaultBranchWorkspace(false)
  }
  // Why: with "Hide sleeping" on, a freshly imported project has no live PTY
  // yet, so the opted-out exemption would leave it invisible on arrival.
  if (
    importedWorktrees.length > 0 &&
    state.alwaysShowDefaultBranchWorkspace === false &&
    !state.showSleepingWorkspaces &&
    importedWorktrees.every((worktree) => worktree.isMainWorktree)
  ) {
    state.setAlwaysShowDefaultBranchWorkspace(true)
  }
}
