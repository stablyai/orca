import type { ProjectGroup } from './project-group-types'
import type { Repo, RepoKind } from './repo-types'

/** One project inside a group, in the shape handed to agents. */
export type ProjectGroupMember = {
  id: string
  name: string
  path: string
  kind: RepoKind
}

export function resolveProjectGroupMembers(
  projectGroupId: string,
  repos: readonly Repo[]
): ProjectGroupMember[] {
  return (
    repos
      .filter((repo) => repo.projectGroupId === projectGroupId)
      .map((repo) => ({
        id: repo.id,
        name: repo.displayName,
        path: repo.path,
        kind: repo.kind ?? 'git'
      }))
      // Why: agents diff this payload across runs, so the order must not depend
      // on sidebar ordering or store insertion order.
      .sort((a, b) => (a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name)))
  )
}

/**
 * Environment exposed to every agent in a grouped workspace, so it can route
 * work to a sibling project without a hand-maintained table of absolute paths.
 * Returns nothing for ungrouped workspaces, which keeps the env untouched.
 */
export function resolveProjectGroupEnv(
  projectGroupId: string | null | undefined,
  repos: readonly Repo[],
  projectGroups: readonly ProjectGroup[]
): Record<string, string> {
  if (!projectGroupId) {
    return {}
  }
  const group = projectGroups.find((candidate) => candidate.id === projectGroupId)
  if (!group) {
    return {}
  }
  return {
    ORCA_PROJECT_GROUP_ID: group.id,
    ORCA_PROJECT_GROUP_NAME: group.name,
    ORCA_PROJECT_GROUP_PROJECTS: JSON.stringify(resolveProjectGroupMembers(group.id, repos))
  }
}
