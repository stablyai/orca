export const PROJECT_REPO_FILTER_EXACT_CAPABILITY = 'ui.project-repo-filter-exact.v1' as const

/** In-memory author context; never part of a UI value or a persisted/wire field. */
export type ProjectRepoFilterWriteIntent = {
  environmentId: string
  pairingRevision: number
  exact: boolean
}
