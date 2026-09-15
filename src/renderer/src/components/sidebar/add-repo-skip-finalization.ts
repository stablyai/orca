import type { Worktree } from '../../../../shared/worktree/types'
import { isDefaultBranchWorkspace } from './default-branch-workspace'

export type AddRepoSkipFinalizationState = {
  activeRepoId: string | null
  filterRepoIds: readonly string[]
  showActiveOnly: boolean
  /** Read, never reset: empty-project-placeholder-repos keeps a header for a
   *  default-checkout-only project, so the import still lands visibly. */
  hideDefaultBranchWorkspace: boolean
  showSleepingWorkspaces: boolean
  alwaysShowDefaultBranchWorkspace: boolean
  worktreesByRepo: Record<string, Worktree[]>
  setActiveRepo: (repoId: string | null) => void
  setFilterRepoIds: (repoIds: string[]) => void
  setShowActiveOnly: (value: boolean) => void
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
  if (state.filterRepoIds.length > 0 && !state.filterRepoIds.includes(importedRepoId)) {
    state.setFilterRepoIds([])
  }
  if (state.showActiveOnly) {
    state.setShowActiveOnly(false)
  }
  // Why: with "Hide sleeping" on, a freshly imported project has no live PTY
  // yet, so the opted-out exemption would leave it invisible on arrival.
  // Rows the default-branch filter already hides stay hidden either way, so
  // the exemption is only flipped for imports that filter leaves visible.
  const hiddenByDefaultBranchFilter =
    state.hideDefaultBranchWorkspace &&
    importedWorktrees.every((worktree) => isDefaultBranchWorkspace(worktree))
  if (
    importedWorktrees.length > 0 &&
    !hiddenByDefaultBranchFilter &&
    state.alwaysShowDefaultBranchWorkspace === false &&
    !state.showSleepingWorkspaces &&
    importedWorktrees.every((worktree) => worktree.isMainWorktree)
  ) {
    state.setAlwaysShowDefaultBranchWorkspace(true)
  }
}
