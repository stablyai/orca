/** A repo's project is the one named after the repo, or one that lists it as a source repo. */
export function projectMatchesRepo(
  project: { id: string; sourceRepoIds?: readonly string[] },
  repoId: string
): boolean {
  return project.id === repoId || (project.sourceRepoIds?.includes(repoId) ?? false)
}
