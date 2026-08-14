import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import type { AppState } from '@/store/types'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import { useFolderWorkspacePathStatusCacheExpiryTick } from '@/lib/folder-workspace-path-status-cache-expiry'
import { getFolderPathStatusRouteOptionsForRows } from './worktree-list-host-filtering'

export function useWorktreeFolderPathStatuses(args: {
  allRepoIds: readonly string[]
  repoMap: Map<string, Repo>
  projectGroups: readonly ProjectGroup[]
  folderWorkspaces: readonly FolderWorkspace[]
  sshConnectionStates: AppState['sshConnectionStates']
}) {
  const { allRepoIds, repoMap, projectGroups, folderWorkspaces, sshConnectionStates } = args
  const {
    folderWorkspacePathStatuses,
    fetchFolderWorkspacePathStatus,
    getFolderWorkspacePathStatusCacheKey,
    getFreshFolderWorkspacePathStatus,
    activeRuntimeEnvironmentId
  } = useAppStore(
    useShallow((state) => ({
      folderWorkspacePathStatuses: state.folderWorkspacePathStatuses,
      fetchFolderWorkspacePathStatus: state.fetchFolderWorkspacePathStatus,
      getFolderWorkspacePathStatusCacheKey: state.getFolderWorkspacePathStatusCacheKey,
      getFreshFolderWorkspacePathStatus: state.getFreshFolderWorkspacePathStatus,
      activeRuntimeEnvironmentId: state.settings?.activeRuntimeEnvironmentId ?? null
    }))
  )
  const repoMembershipKey = useMemo(
    () =>
      allRepoIds
        .map((repoId) => {
          const repo = repoMap.get(repoId)
          return `${repoId}:${repo?.path ?? ''}:${repo?.projectGroupId ?? ''}:${repo?.connectionId ?? ''}`
        })
        .join('\0'),
    [allRepoIds, repoMap]
  )
  const sshConnectionKey = useMemo(
    () =>
      [...sshConnectionStates.entries()]
        .map(([connectionId, state]) => `${connectionId}:${state.status}`)
        .sort()
        .join('\0'),
    [sshConnectionStates]
  )
  const cacheExpiryTick = useFolderWorkspacePathStatusCacheExpiryTick(folderWorkspacePathStatuses)
  const projectGroupsById = useMemo(
    () => new Map(projectGroups.map((group) => [group.id, group])),
    [projectGroups]
  )
  const folderWorkspacesById = useMemo(
    () => new Map(folderWorkspaces.map((workspace) => [workspace.id, workspace])),
    [folderWorkspaces]
  )
  const getRouteOptions = useCallback(
    (request: Parameters<typeof fetchFolderWorkspacePathStatus>[0]) =>
      getFolderPathStatusRouteOptionsForRows({
        request,
        projectGroupsById,
        folderWorkspacesById
      }),
    [folderWorkspacesById, projectGroupsById]
  )
  useEffect(() => {
    const requests = new Map<
      string,
      {
        request: Parameters<typeof fetchFolderWorkspacePathStatus>[0]
        options?: { runtimeEnvironmentId: string | null }
      }
    >()
    for (const group of projectGroups) {
      if (group.parentPath) {
        const request = { scope: 'project-group' as const, projectGroupId: group.id }
        const options = getRouteOptions(request)
        requests.set(getFolderWorkspacePathStatusCacheKey(request, options), { request, options })
      }
    }
    for (const workspace of folderWorkspaces) {
      const request = { scope: 'folder-workspace' as const, folderWorkspaceId: workspace.id }
      const options = getRouteOptions(request)
      requests.set(getFolderWorkspacePathStatusCacheKey(request, options), { request, options })
    }
    for (const { request, options } of requests.values()) {
      void fetchFolderWorkspacePathStatus(request, { force: true, ...options })
    }
  }, [
    activeRuntimeEnvironmentId,
    fetchFolderWorkspacePathStatus,
    repoMembershipKey,
    sshConnectionKey,
    folderWorkspaces,
    getRouteOptions,
    getFolderWorkspacePathStatusCacheKey,
    projectGroups
  ])
  return useCallback(
    (request: Parameters<typeof fetchFolderWorkspacePathStatus>[0]) => {
      const options = getRouteOptions(request)
      const cacheKey = getFolderWorkspacePathStatusCacheKey(request, options)
      // Why: don't let an expired negative status keep folder workspaces disabled while a refresh is in flight.
      void folderWorkspacePathStatuses[cacheKey]
      void cacheExpiryTick
      return getFreshFolderWorkspacePathStatus(request, options)
    },
    [
      folderWorkspacePathStatuses,
      cacheExpiryTick,
      getRouteOptions,
      getFolderWorkspacePathStatusCacheKey,
      getFreshFolderWorkspacePathStatus
    ]
  )
}
