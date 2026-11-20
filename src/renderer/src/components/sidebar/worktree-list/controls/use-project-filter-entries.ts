import { useMemo } from 'react'
import { useProjectHostSetupProjection } from '@/store/projects/use-project-host-setup-projection'
import { searchRepos } from '@/lib/workspace/catalog/repo-search'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { buildProjectGroupingIndex } from '../../../../../../shared/sidebar-list/sections/project-section-grouping'
import {
  buildProjectFilterEntries,
  type ProjectFilterEntry
} from '../../../../../../shared/sidebar-list/sections/project-filter-entries'

export type RepoProjectFilterEntry = ProjectFilterEntry<Repo>

/** One entry per sidebar project section, with every host's checkout. */
export function useProjectFilterEntries(repos: readonly Repo[]): RepoProjectFilterEntry[] {
  const projection = useProjectHostSetupProjection()
  return useMemo(
    () =>
      buildProjectFilterEntries(
        repos,
        buildProjectGroupingIndex({
          projects: projection.projects,
          projectHostSetups: projection.setups
        })
      ),
    [repos, projection]
  )
}

/** Entries whose project name, or any checkout's name or path, matches; best match first. */
export function searchProjectFilterEntries(
  entries: readonly RepoProjectFilterEntry[],
  query: string
): RepoProjectFilterEntry[] {
  const entryByKey = new Map(entries.map((entry) => [entry.key, entry]))
  // Search each checkout under its entry's key so any host's path finds the project.
  const candidates = entries.flatMap((entry) => [
    { ...entry.repo, id: entry.key, displayName: entry.label },
    ...entry.repos.map((repo) => ({ ...repo, id: entry.key }))
  ])
  const matches = new Map<string, RepoProjectFilterEntry>()
  for (const match of searchRepos(candidates, query)) {
    const entry = entryByKey.get(match.id)
    if (entry && !matches.has(entry.key)) {
      matches.set(entry.key, entry)
    }
  }
  return [...matches.values()]
}

/** Keywords for the panel's command filter: the project name, then every checkout's name and path. */
export function projectFilterEntryKeywords(entry: RepoProjectFilterEntry): [string, string] {
  return [entry.label, entry.repos.map((repo) => `${repo.displayName} ${repo.path}`).join('\n')]
}
