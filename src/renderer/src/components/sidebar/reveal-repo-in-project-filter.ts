/**
 * The sidebar "Projects" filter (`filterRepoIds`) is a show-only-these
 * allowlist. When a flow needs to reveal a specific repo's workspaces through
 * an active filter (importing a project, jumping to a hidden worktree), it must
 * add that repo to the selection — never wipe the filter, which would drop every
 * other project the user deliberately filtered to.
 *
 * Returns the next `filterRepoIds` to apply, or null when no change is needed:
 * an empty filter already shows all repos, and a repo already selected is a
 * no-op. Centralized so no caller reintroduces the "clear the whole filter" bug.
 */
export function revealRepoInProjectFilter(
  filterRepoIds: readonly string[],
  repoId: string
): string[] | null {
  if (filterRepoIds.length === 0 || filterRepoIds.includes(repoId)) {
    return null
  }
  return [...filterRepoIds, repoId]
}
