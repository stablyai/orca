import {
  DEFAULT_SPACE_ID,
  isDefaultSpaceId,
  isRepoInSpace,
  resolveSpaceId
} from '../../../../shared/spaces'
import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../../shared/types'
import { getRepoHostIdentityForParts } from '@/store/slices/repo-host-identity'

type SpaceScopedRepo = Pick<Repo, 'spaceId' | 'projectGroupId'>

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
  repoMap: ReadonlyMap<string, Pick<Repo, 'spaceId'>>,
  activeSpaceFilterId: string | null,
  repoByHostIdentity?: ReadonlyMap<string, Pick<Repo, 'spaceId'>>
): boolean {
  if (!activeSpaceFilterId) {
    return true
  }
  const repo =
    worktree.hostId && repoByHostIdentity
      ? repoByHostIdentity.get(getRepoHostIdentityForParts(worktree.repoId, worktree.hostId))
      : repoMap.get(worktree.repoId)
  return repo != null && isRepoInSpace(repo, activeSpaceFilterId)
}

export function filterReposForActiveSpace<T extends Pick<Repo, 'spaceId'>>(
  repos: readonly T[],
  activeSpaceFilterId: string | null
): readonly T[] {
  if (!activeSpaceFilterId) {
    return repos
  }
  return repos.filter((repo) => isRepoInSpace(repo, activeSpaceFilterId))
}

/** Groups inherit project memberships; empty groups belong to Default. */
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
    const isVisible = spaceIds
      ? spaceIds.has(activeSpaceFilterId)
      : isDefaultSpaceId(activeSpaceFilterId)
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
