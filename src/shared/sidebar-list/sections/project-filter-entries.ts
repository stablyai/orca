import {
  getProjectGroupingForRepo,
  type ProjectGroupingIndex,
  type ProjectSectionRepo
} from './project-section-grouping'

/** Every host's checkout of a project the sidebar shows as one section. */
export type ProjectFilterEntry<R extends ProjectSectionRepo = ProjectSectionRepo> = {
  key: string
  label: string
  /** The first checkout listed; supplies the badge color. */
  repo: R
  repos: R[]
  repoIds: string[]
}

/** Group repos the way sidebar project headers do, keeping first-seen order. */
export function buildProjectFilterEntries<R extends ProjectSectionRepo>(
  repos: readonly R[],
  projectIndex: ProjectGroupingIndex | null
): ProjectFilterEntry<R>[] {
  const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
  const entries = new Map<string, ProjectFilterEntry<R>>()
  for (const repo of repos) {
    const grouping = getProjectGroupingForRepo(repo.id, repoMap, projectIndex)
    const entry = entries.get(grouping.key)
    if (!entry) {
      entries.set(grouping.key, {
        key: grouping.key,
        label: grouping.label,
        repo,
        repos: [repo],
        repoIds: [repo.id]
      })
      continue
    }
    entry.repos.push(repo)
    // Same-id registrations on two hosts keep both checkouts (for search) but one filter id.
    if (!entry.repoIds.includes(repo.id)) {
      entry.repoIds.push(repo.id)
    }
  }
  return [...entries.values()]
}

// The stored filter stays a repo-id list so its readers are unchanged. A project counts as selected
// when any checkout is, so filters saved per checkout (or narrowed by reveal) still show.
export function isProjectFilterEntrySelected(
  entry: Pick<ProjectFilterEntry, 'repoIds'>,
  filterRepoIds: readonly string[]
): boolean {
  return entry.repoIds.some((repoId) => filterRepoIds.includes(repoId))
}

/** Ids no listed project owns are kept; every selected project gains all of its checkouts. */
function withEverySelectedCheckout(
  filterRepoIds: readonly string[],
  entries: readonly Pick<ProjectFilterEntry, 'repoIds'>[]
): string[] {
  const next = new Set(filterRepoIds)
  for (const entry of entries) {
    if (isProjectFilterEntrySelected(entry, filterRepoIds)) {
      for (const repoId of entry.repoIds) {
        next.add(repoId)
      }
    }
  }
  return [...next]
}

// Why complete every selected project on each change: a partly saved project (older per-checkout
// filters, reveal, a host whose repos returned) would otherwise keep hiding some hosts' workspaces.
export function withProjectFilterEntry(
  filterRepoIds: readonly string[],
  entry: Pick<ProjectFilterEntry, 'repoIds'>,
  entries: readonly Pick<ProjectFilterEntry, 'repoIds'>[]
): string[] {
  return withEverySelectedCheckout([...filterRepoIds, ...entry.repoIds], entries)
}

export function withoutProjectFilterEntry(
  filterRepoIds: readonly string[],
  entry: Pick<ProjectFilterEntry, 'repoIds'>,
  entries: readonly Pick<ProjectFilterEntry, 'repoIds'>[]
): string[] {
  return withEverySelectedCheckout(
    filterRepoIds.filter((repoId) => !entry.repoIds.includes(repoId)),
    entries
  )
}
