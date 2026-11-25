import { useMemo } from 'react'
import { useAppStore } from '../index'
import { useShallow } from 'zustand/react/shallow'
import { getIndexedRepoMap as getCachedRepoMap } from './repository-catalog-index'
import { selectRepoByIdForActiveWorkspace } from './active-workspace-repository'
import { findRemoteProjectGroupMembership } from '../project-groups/project-group-remote-members'

export const useRepos = () => useAppStore((s) => s.repos)

export const useActiveRepo = () =>
  useAppStore(useShallow((s) => selectRepoByIdForActiveWorkspace(s, s.activeRepoId)))

export const useRepoMap = () => useAppStore((s) => getCachedRepoMap(s.repos))

export const useRepoById = (repoId: string | null) =>
  useAppStore((s) => selectRepoByIdForActiveWorkspace(s, repoId))

/** The repo as the sidebar groups it, so group actions see a remote project's client-group membership. */
export function useSidebarRepoById(repoId: string | null) {
  const repo = useRepoById(repoId)
  const clientGroupId = useAppStore((s) =>
    repo ? (findRemoteProjectGroupMembership(s.projectGroups, repo)?.groupId ?? null) : null
  )
  return useMemo(
    () => (repo && clientGroupId ? { ...repo, projectGroupId: clientGroupId } : repo),
    [repo, clientGroupId]
  )
}
