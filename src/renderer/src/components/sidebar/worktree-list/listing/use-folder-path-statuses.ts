import { useCallback, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useFolderWorkspacePathStatusCacheExpiryTick } from '@/lib/folder-workspace-path-status-cache-expiry'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { AppState } from '@/store/types'
import { getFolderPathStatusRouteOptionsForRows } from './host-filtering'

type FolderPathStatusRequest = Parameters<AppState['fetchFolderWorkspacePathStatus']>[0]

// Keeps the sidebar's folder-path probes fresh for every project group and folder workspace
// it renders, and hands rows a cache reader that ignores expired negative results.
export function useFolderWorkspacePathStatusRows(args: {
  allRepoIds: string[]
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
    useShallow((s) => ({
      folderWorkspacePathStatuses: s.folderWorkspacePathStatuses,
      fetchFolderWorkspacePathStatus: s.fetchFolderWorkspacePathStatus,
      getFolderWorkspacePathStatusCacheKey: s.getFolderWorkspacePathStatusCacheKey,
      getFreshFolderWorkspacePathStatus: s.getFreshFolderWorkspacePathStatus,
      activeRuntimeEnvironmentId: s.settings?.activeRuntimeEnvironmentId ?? null
    }))
  )
  const folderPathStatusRepoMembershipKey = useMemo(
    () =>
      allRepoIds
        .map((repoId) => {
          const repo = repoMap.get(repoId)
          return `${repoId}:${repo?.path ?? ''}:${repo?.projectGroupId ?? ''}:${repo?.connectionId ?? ''}`
        })
        .join('\0'),
    [allRepoIds, repoMap]
  )
  const folderPathStatusSshConnectionKey = useMemo(
    () =>
      [...sshConnectionStates.entries()]
        .map(([connectionId, state]) => `${connectionId}:${state.status}`)
        .sort()
        .join('\0'),
    [sshConnectionStates]
  )
  const folderPathStatusCacheExpiryTick = useFolderWorkspacePathStatusCacheExpiryTick(
    folderWorkspacePathStatuses
  )
  const projectGroupByIdForFolderPathStatus = useMemo(
    () => new Map(projectGroups.map((group) => [group.id, group])),
    [projectGroups]
  )
  const folderWorkspaceByIdForFolderPathStatus = useMemo(
    () => new Map(folderWorkspaces.map((workspace) => [workspace.id, workspace])),
    [folderWorkspaces]
  )
  const getFolderPathStatusRouteOptions = useCallback(
    (request: FolderPathStatusRequest) =>
      getFolderPathStatusRouteOptionsForRows({
        request,
        projectGroupsById: projectGroupByIdForFolderPathStatus,
        folderWorkspacesById: folderWorkspaceByIdForFolderPathStatus
      }),
    [folderWorkspaceByIdForFolderPathStatus, projectGroupByIdForFolderPathStatus]
  )
  useEffect(() => {
    const requests = new Map<
      string,
      {
        request: FolderPathStatusRequest
        options?: { runtimeEnvironmentId: string | null }
      }
    >()
    for (const group of projectGroups) {
      if (group.parentPath) {
        const request = { scope: 'project-group' as const, projectGroupId: group.id }
        const options = getFolderPathStatusRouteOptions(request)
        requests.set(getFolderWorkspacePathStatusCacheKey(request, options), { request, options })
      }
    }
    for (const workspace of folderWorkspaces) {
      const request = { scope: 'folder-workspace' as const, folderWorkspaceId: workspace.id }
      const options = getFolderPathStatusRouteOptions(request)
      requests.set(getFolderWorkspacePathStatusCacheKey(request, options), { request, options })
    }
    for (const { request, options } of requests.values()) {
      void fetchFolderWorkspacePathStatus(request, { force: true, ...options })
    }
  }, [
    activeRuntimeEnvironmentId,
    fetchFolderWorkspacePathStatus,
    folderPathStatusRepoMembershipKey,
    folderPathStatusSshConnectionKey,
    folderWorkspaces,
    getFolderPathStatusRouteOptions,
    getFolderWorkspacePathStatusCacheKey,
    projectGroups
  ])
  const getCachedFolderWorkspacePathStatus = useCallback(
    (request: FolderPathStatusRequest) => {
      const options = getFolderPathStatusRouteOptions(request)
      const cacheKey = getFolderWorkspacePathStatusCacheKey(request, options)
      // Why: don't let an expired negative status keep folder workspaces disabled while a refresh is in flight.
      void folderWorkspacePathStatuses[cacheKey]
      void folderPathStatusCacheExpiryTick
      return getFreshFolderWorkspacePathStatus(request, options)
    },
    [
      folderWorkspacePathStatuses,
      folderPathStatusCacheExpiryTick,
      getFolderPathStatusRouteOptions,
      getFolderWorkspacePathStatusCacheKey,
      getFreshFolderWorkspacePathStatus
    ]
  )

  return getCachedFolderWorkspacePathStatus
}
