// Why: catalog refreshes re-filter this on every fetch; six identity-sensitive subscribers
// (App.tsx at the root among them) re-render on a new array even when nothing was pruned.
export function retainValidFilterRepoIds(
  filterRepoIds: readonly string[],
  validRepoIds: ReadonlySet<string>
): readonly string[] {
  return filterRepoIds.every((repoId) => validRepoIds.has(repoId))
    ? filterRepoIds
    : filterRepoIds.filter((repoId) => validRepoIds.has(repoId))
}

// Why: reveal/import must make the target visible without dropping the user's project selection, so widen the filter instead of clearing it.
export function widenFilterRepoIds(
  filterRepoIds: readonly string[],
  repoIds: readonly string[]
): string[] | null {
  if (filterRepoIds.length === 0) {
    return null
  }
  const missing = repoIds.filter((id) => !filterRepoIds.includes(id))
  return missing.length > 0 ? [...filterRepoIds, ...missing] : null
}
