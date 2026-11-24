import {
  revealRepoInProjectFilter,
  type ProjectFilterRevealState
} from '../../worktree-list/controls/project-filter-reveal'

export type AddRepoSkipFinalizationState = ProjectFilterRevealState & {
  activeRepoId: string | null
  showActiveOnly: boolean
  setActiveRepo: (repoId: string | null) => void
  setShowActiveOnly: (value: boolean) => void
}

export function finalizeImportedRepoAfterSkip(
  state: AddRepoSkipFinalizationState,
  importedRepoId: string
): void {
  // Skip avoids workspace creation/activation; it must still reveal the imported project through sidebar filters.
  if (state.activeRepoId !== importedRepoId) {
    state.setActiveRepo(importedRepoId)
  }
  revealRepoInProjectFilter(state, importedRepoId)
  if (state.showActiveOnly) {
    state.setShowActiveOnly(false)
  }
}
