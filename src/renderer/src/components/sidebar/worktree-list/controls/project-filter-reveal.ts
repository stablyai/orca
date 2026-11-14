export type ProjectFilterRevealState = {
  filterRepoIds: readonly string[]
  setFilterRepoIds: (repoIds: readonly string[]) => void
}

export function revealRepoInProjectFilter(state: ProjectFilterRevealState, repoId: string): void {
  // Why: an empty allow-list disables filtering, so adding one id would narrow the unfiltered view.
  if (state.filterRepoIds.length === 0 || state.filterRepoIds.includes(repoId)) {
    return
  }
  state.setFilterRepoIds([...state.filterRepoIds, repoId])
}
