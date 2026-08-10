import {
  DEFAULT_SPACE_ID,
  isDefaultSpaceId,
  isRepoInSpace,
  resolveSpaceId
} from '../../../../shared/spaces'
import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../../shared/types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '@/store/slices/repo-host-identity'

type SpaceMembershipRepo = Pick<Repo, 'spaceId'> &
  Partial<Pick<Repo, 'connectionId' | 'executionHostId'>>
type SpaceScopedRepo = SpaceMembershipRepo & Pick<Repo, 'projectGroupId'>

/**
 * Runtime-owned rows never carry Space membership (see repoWithFetchedOwner), so scoping them
 * would empty the sidebar for every non-Default Space while a runtime environment is active.
 */
function isSpaceExemptRepo(repo: SpaceMembershipRepo): boolean {
  return parseExecutionHostId(getRepoExecutionHostId(repo))?.kind === 'runtime'
}

function repoPassesSpaceFilter(repo: SpaceMembershipRepo, activeSpaceFilterId: string): boolean {
  return isSpaceExemptRepo(repo) || isRepoInSpace(repo, activeSpaceFilterId)
}

/** Null preserves the pre-Spaces path until a project leaves Default. */
export function getActiveSpaceFilterId(
  activeSpaceId: string | null | undefined,
  repos: Iterable<Pick<Repo, 'spaceId'>>
): string | null {
  const resolved = resolveSpaceId(activeSpaceId)
  if (resolved !== DEFAULT_SPACE_ID) {
    return resolved
  }
  for (const repo of repos) {
    if (!isDefaultSpaceId(repo.spaceId)) {
      return resolved
    }
  }
  return null
}

export function isWorktreeInActiveSpace(
  worktree: Pick<Worktree, 'repoId' | 'hostId'>,
  repoMap: ReadonlyMap<string, SpaceMembershipRepo>,
  activeSpaceFilterId: string | null,
  repoByHostIdentity?: ReadonlyMap<string, SpaceMembershipRepo>
): boolean {
  if (!activeSpaceFilterId) {
    return true
  }
  const repo =
    worktree.hostId && repoByHostIdentity
      ? repoByHostIdentity.get(getRepoHostIdentityForParts(worktree.repoId, worktree.hostId))
      : repoMap.get(worktree.repoId)
  return repo != null && repoPassesSpaceFilter(repo, activeSpaceFilterId)
}

export function filterReposForActiveSpace<T extends SpaceMembershipRepo>(
  repos: readonly T[],
  activeSpaceFilterId: string | null
): readonly T[] {
  if (!activeSpaceFilterId) {
    return repos
  }
  return repos.filter((repo) => repoPassesSpaceFilter(repo, activeSpaceFilterId))
}

/**
 * Groups inherit project memberships. A group no Space-bearing project claims — one holding only
 * folder workspaces, only runtime rows, or nothing — stays visible everywhere, because Spaces are
 * assigned per project and such a group has no way to be moved out of hiding.
 */
export function getActiveSpaceProjectGroupIdSet(
  projectGroups: readonly ProjectGroup[],
  repos: readonly SpaceScopedRepo[],
  activeSpaceFilterId: string | null
): ReadonlySet<string> | null {
  if (!activeSpaceFilterId) {
    return null
  }
  const parentGroupIdById = new Map(projectGroups.map((group) => [group.id, group.parentGroupId]))
  const spaceIdsByGroupId = new Map<string, Set<string>>()
  for (const repo of repos) {
    if (isSpaceExemptRepo(repo)) {
      continue
    }
    const spaceId = resolveSpaceId(repo.spaceId)
    let groupId = repo.projectGroupId ?? null
    const walked = new Set<string>()
    while (groupId && !walked.has(groupId)) {
      walked.add(groupId)
      const spaceIds = spaceIdsByGroupId.get(groupId)
      if (spaceIds) {
        spaceIds.add(spaceId)
      } else {
        spaceIdsByGroupId.set(groupId, new Set([spaceId]))
      }
      groupId = parentGroupIdById.get(groupId) ?? null
    }
  }
  const visibleGroupIds = new Set<string>()
  for (const group of projectGroups) {
    const spaceIds = spaceIdsByGroupId.get(group.id)
    const isVisible = spaceIds ? spaceIds.has(activeSpaceFilterId) : true
    if (isVisible) {
      visibleGroupIds.add(group.id)
    }
  }
  return visibleGroupIds
}

export function filterProjectGroupsForActiveSpace(
  projectGroups: readonly ProjectGroup[],
  activeSpaceProjectGroupIds: ReadonlySet<string> | null
): readonly ProjectGroup[] {
  if (!activeSpaceProjectGroupIds) {
    return projectGroups
  }
  return projectGroups.filter((group) => activeSpaceProjectGroupIds.has(group.id))
}

export function filterFolderWorkspacesForActiveSpace(
  folderWorkspaces: readonly FolderWorkspace[],
  activeSpaceProjectGroupIds: ReadonlySet<string> | null
): readonly FolderWorkspace[] {
  if (!activeSpaceProjectGroupIds) {
    return folderWorkspaces
  }
  return folderWorkspaces.filter((folderWorkspace) =>
    activeSpaceProjectGroupIds.has(folderWorkspace.projectGroupId)
  )
}
