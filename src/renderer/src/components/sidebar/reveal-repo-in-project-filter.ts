/** Adds a repo to the "show-only-these" project filter without wiping other selections; null = no change (empty filter or already selected). */
export function revealRepoInProjectFilter(
  filterRepoIds: readonly string[],
  repoId: string
): string[] | null {
  if (filterRepoIds.length === 0 || filterRepoIds.includes(repoId)) {
    return null
  }
  return [...filterRepoIds, repoId]
}
