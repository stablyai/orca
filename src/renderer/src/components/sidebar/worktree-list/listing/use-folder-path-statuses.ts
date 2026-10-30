import { useCallback, useEffect, useMemo } from 'react'
import { getFolderWorkspaceStatusRequestDependencies } from '@/store/folder-workspaces/folder-path-status'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { useFolderWorkspacePathStatusCacheExpiryTick } from '@/lib/folder-workspace-path-status-cache-expiry'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { AppState } from '@/store/types'
import { getFolderPathStatusRouteOptionsForRows } from './folder-path-status-routing'

type FolderPathStatusRequest = Parameters<AppState['fetchFolderWorkspacePathStatus']>[0]

type RoutedRequest = {
  request: FolderPathStatusRequest
  options: { runtimeEnvironmentId: string | null }
}
const EMPTY_DEPENDENCIES: readonly string[] = []

function createFolderPathStatusDependenciesSelector(requests: ReadonlyMap<string, RoutedRequest>) {
  let repos: AppState['repos'] | undefined
  let groups: AppState['projectGroups'] | undefined
  let folders: AppState['folderWorkspaces'] | undefined
  let ssh: AppState['sshConnectionStates'] | undefined
  let connectionIds: string[] = []
  let membership = ''
  let result = EMPTY_DEPENDENCIES
  return (state: AppState) => {
    if (requests.size === 0) {
      return EMPTY_DEPENDENCIES
    }
    const nextFolders = selectFolderWorkspaces(state)
    if (
      repos === state.repos &&
      groups === state.projectGroups &&
      folders === nextFolders &&
      ssh === state.sshConnectionStates
    ) {
      return result
    }
    if (repos !== state.repos || groups !== state.projectGroups || folders !== nextFolders) {
      const dependencies = [...requests.values()].map(({ request, options }) =>
        getFolderWorkspaceStatusRequestDependencies(state, request, options)
      )
      membership = JSON.stringify(
        dependencies.map((value) => value && [value.scope, value.repoFingerprint])
      )
      connectionIds = [
        ...new Set(dependencies.flatMap((value) => (value ? [...value.relevantConnectionIds] : [])))
      ].sort()
    }
    repos = state.repos
    groups = state.projectGroups
    folders = nextFolders
    ssh = state.sshConnectionStates
    let next: string[] | undefined
    if (result[0] !== membership || result.length !== connectionIds.length + 1) {
      next = [membership]
    }
    for (let index = 0; index < connectionIds.length; index++) {
      const status = state.sshConnectionStates.get(connectionIds[index]!)?.status ?? 'missing'
      if (next || result[index + 1] !== status) {
        next ??= [...result]
        next[index + 1] = status
      }
    }
    if (next) {
      result = next
    }
    return result
  }
}

// Refresh rendered folder paths and ignore expired negative results while reprobes run.
export function useFolderWorkspacePathStatusRows(args: {
  allRepoIds: string[]
  repoMap: Map<string, Repo>
  projectGroups: readonly ProjectGroup[]
  folderWorkspaces: readonly FolderWorkspace[]
}) {
  const { allRepoIds, repoMap, projectGroups, folderWorkspaces } = args
  const {
    folderWorkspacePathStatuses,
    fetchFolderWorkspacePathStatus,
    getFolderWorkspacePathStatusCacheKey,
    getFreshFolderWorkspacePathStatus
  } = useAppStore(
    useShallow((s) => ({
      folderWorkspacePathStatuses: s.folderWorkspacePathStatuses,
      fetchFolderWorkspacePathStatus: s.fetchFolderWorkspacePathStatus,
      getFolderWorkspacePathStatusCacheKey: s.getFolderWorkspacePathStatusCacheKey,
      getFreshFolderWorkspacePathStatus: s.getFreshFolderWorkspacePathStatus
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
  const requests = useMemo(() => {
    const requests = new Map<string, RoutedRequest>()
    // Why: a request whose group row has not landed has no owner to ask, so it waits.
    const addRequest = (request: FolderPathStatusRequest): void => {
      const options = getFolderPathStatusRouteOptions(request)
      if (options) {
        requests.set(getFolderWorkspacePathStatusCacheKey(request, options), { request, options })
      }
    }
    for (const group of projectGroups) {
      if (group.parentPath) {
        addRequest({ scope: 'project-group' as const, projectGroupId: group.id })
      }
    }
    for (const workspace of folderWorkspaces) {
      addRequest({ scope: 'folder-workspace' as const, folderWorkspaceId: workspace.id })
    }
    return requests
  }, [
    folderWorkspaces,
    getFolderPathStatusRouteOptions,
    getFolderWorkspacePathStatusCacheKey,
    projectGroups
  ])
  const selectDependencies = useMemo(
    () => createFolderPathStatusDependenciesSelector(requests),
    [requests]
  )
  const dependencies = useAppStore(selectDependencies)
  useEffect(() => {
    for (const { request, options } of requests.values()) {
      void fetchFolderWorkspacePathStatus(request, { force: true, ...options })
    }
  }, [
    fetchFolderWorkspacePathStatus,
    folderPathStatusRepoMembershipKey,
    dependencies,
    requests,
    folderWorkspaces,
    getFolderPathStatusRouteOptions,
    getFolderWorkspacePathStatusCacheKey,
    projectGroups
  ])
  const getCachedFolderWorkspacePathStatus = useCallback(
    (request: FolderPathStatusRequest) => {
      const options = getFolderPathStatusRouteOptions(request)
      if (!options) {
        return null
      }
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
