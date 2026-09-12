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
