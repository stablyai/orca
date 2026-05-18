import type { Worktree } from '../../../../shared/types'
import { isDefaultBranchWorkspace } from './visible-worktrees'

export type AddRepoSkipFinalizationState = {
  activeRepoId: string | null
  filterRepoIds: string[]
  showActiveOnly: boolean
  hideDefaultBranchWorkspace: boolean
  worktreesByRepo: Record<string, Worktree[]>
  setActiveRepo: (repoId: string | null) => void
  setFilterRepoIds: (repoIds: string[]) => void
  setShowActiveOnly: (value: boolean) => void
  setHideDefaultBranchWorkspace: (value: boolean) => void
}

export function finalizeImportedRepoAfterSkip(
  state: AddRepoSkipFinalizationState,
  importedRepoId: string
): void {
  const importedWorktrees = state.worktreesByRepo[importedRepoId] ?? []
  if (importedWorktrees.length === 0) {
    return
  }

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
  if (
    state.hideDefaultBranchWorkspace &&
    importedWorktrees.every((worktree) => isDefaultBranchWorkspace(worktree))
  ) {
    state.setHideDefaultBranchWorkspace(false)
  }
}
