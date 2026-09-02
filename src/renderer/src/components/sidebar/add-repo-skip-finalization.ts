import type { Worktree } from '../../../../shared/worktree/types'
import { isDefaultBranchWorkspace } from './default-branch-workspace'
import { widenFilterRepoIds } from '@/store/slices/repo-filter-selection'

export type AddRepoSkipFinalizationState = {
  activeRepoId: string | null
  filterRepoIds: readonly string[]
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
  // Why: widen the filter rather than clear it, so an active project selection survives adding a project.
  const widenedFilterRepoIds = widenFilterRepoIds(state.filterRepoIds, [importedRepoId])
  if (widenedFilterRepoIds) {
    state.setFilterRepoIds(widenedFilterRepoIds)
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
