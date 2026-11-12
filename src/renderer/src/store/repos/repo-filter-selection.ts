// Preserve equal filter arrays on catalog refresh or six identity-sensitive subscribers, including App root, rerender.
export function retainValidFilterRepoIds(
  filterRepoIds: readonly string[],
  validRepoIds: ReadonlySet<string>
): readonly string[] {
  return filterRepoIds.every((repoId) => validRepoIds.has(repoId))
    ? filterRepoIds
    : filterRepoIds.filter((repoId) => validRepoIds.has(repoId))
}
