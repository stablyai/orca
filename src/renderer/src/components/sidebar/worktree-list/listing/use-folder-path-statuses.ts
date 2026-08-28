import { useCallback, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useFolderWorkspacePathStatusCacheExpiryTick } from '@/lib/folder-workspace-path-status-cache-expiry'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { AppState } from '@/store/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../../../shared/execution-host'
import {
  getFolderPathStatusRouteOptionsForRows,
  getRuntimeEnvironmentIdForFolderPathStatusHost
} from './host-filtering'

type FolderPathStatusRequest = Parameters<AppState['fetchFolderWorkspacePathStatus']>[0]
type RepoPathStatusRequest = Extract<FolderPathStatusRequest, { scope: 'repo' }>

// Keeps the sidebar's folder-path probes fresh for every project group and folder workspace
// it renders, and hands rows a cache reader that ignores expired negative results.
export function useFolderWorkspacePathStatusRows(args: {
  repoIds: string[]
  repoMap: Map<string, Repo>
  projectGroups: readonly ProjectGroup[]
  folderWorkspaces: readonly FolderWorkspace[]
  sshConnectionStates: AppState['sshConnectionStates']
}) {
  const { repoIds, repoMap, projectGroups, folderWorkspaces, sshConnectionStates } = args
  const {
    folderWorkspacePathStatuses,
    fetchFolderWorkspacePathStatus,
    getFolderWorkspacePathStatusCacheKey,
    getFreshFolderWorkspacePathStatus,
    repos,
    activeRuntimeEnvironmentId
  } = useAppStore(
    useShallow((s) => ({
      folderWorkspacePathStatuses: s.folderWorkspacePathStatuses,
      fetchFolderWorkspacePathStatus: s.fetchFolderWorkspacePathStatus,
      getFolderWorkspacePathStatusCacheKey: s.getFolderWorkspacePathStatusCacheKey,
      getFreshFolderWorkspacePathStatus: s.getFreshFolderWorkspacePathStatus,
      repos: s.repos,
      activeRuntimeEnvironmentId: s.settings?.activeRuntimeEnvironmentId ?? null
    }))
  )
  const localRepoPathStatusRequests = useMemo(() => {
    const visibleRepoIds = new Set(repoIds)
    const requests = new Map<string, RepoPathStatusRequest>()
    for (const repo of repos) {
      const executionHostId = getRepoExecutionHostId(repo)
      if (visibleRepoIds.has(repo.id) && executionHostId === LOCAL_EXECUTION_HOST_ID) {
        requests.set(`${executionHostId}\0${repo.id}`, {
          scope: 'repo',
          repoId: repo.id,
          executionHostId
        })
      }
    }
    return [...requests.values()]
  }, [repoIds, repos])
  const folderPathStatusRepoMembershipKey = useMemo(
    () =>
      repoIds
        .map((repoId) => {
          const repo = repoMap.get(repoId)
          return `${repoId}:${repo?.path ?? ''}:${repo?.projectGroupId ?? ''}:${repo?.connectionId ?? ''}`
        })
        .join('\0'),
    [repoIds, repoMap]
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
  const localRepoPathStatusEntries = useMemo(() => {
    const entries: typeof folderWorkspacePathStatuses = {}
    for (const request of localRepoPathStatusRequests) {
      const key = getFolderWorkspacePathStatusCacheKey(request, { runtimeEnvironmentId: null })
      const entry = folderWorkspacePathStatuses[key]
      if (entry) {
        entries[key] = entry
      }
    }
    return entries
  }, [
    folderWorkspacePathStatuses,
    getFolderWorkspacePathStatusCacheKey,
    localRepoPathStatusRequests
  ])
  const localRepoPathStatusCacheExpiryTick = useFolderWorkspacePathStatusCacheExpiryTick(
    localRepoPathStatusEntries
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
    (request: FolderPathStatusRequest) => {
      if (request.scope === 'path') {
        return { runtimeEnvironmentId: null }
      }
      if (request.scope === 'repo') {
        return {
          runtimeEnvironmentId: getRuntimeEnvironmentIdForFolderPathStatusHost(
            request.executionHostId
          )
        }
      }
      return getFolderPathStatusRouteOptionsForRows({
        request,
        projectGroupsById: projectGroupByIdForFolderPathStatus,
        folderWorkspacesById: folderWorkspaceByIdForFolderPathStatus
      })
    },
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
  useEffect(() => {
    for (const request of localRepoPathStatusRequests) {
      void fetchFolderWorkspacePathStatus(request, { force: true, runtimeEnvironmentId: null })
    }
  }, [
    fetchFolderWorkspacePathStatus,
    localRepoPathStatusCacheExpiryTick,
    localRepoPathStatusRequests
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
