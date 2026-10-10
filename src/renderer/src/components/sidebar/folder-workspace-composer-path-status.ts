import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useFolderWorkspacePathStatusCacheExpiryTick } from '@/lib/folder-workspace-path-status-cache-expiry'
import {
  getFolderWorkspacePathStatusDescription,
  getFolderWorkspacePathStatusTitle
} from '@/lib/folder-workspace-path-status'
import { isConfirmedStaleFolderPathStatus } from '../../../../shared/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../shared/project-group-types'

export function useFolderWorkspaceComposerPathStatus(
  projectGroup: ProjectGroup | null,
  open: boolean,
  runtimeEnvironmentId?: string | null
): {
  pathStatusBlocksCreate: boolean
  pathStatusProjectError: string | null
} {
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
  const pathStatusRequest = useMemo(
    () =>
      projectGroup ? { scope: 'project-group' as const, projectGroupId: projectGroup.id } : null,
    [projectGroup]
  )
  const cacheExpiryTick = useFolderWorkspacePathStatusCacheExpiryTick(folderWorkspacePathStatuses)
  const activePathStatusRefreshIdRef = useRef(0)
  const previousPathStatusRefreshRef = useRef<{
    request: typeof pathStatusRequest
    cacheKey: string
    refreshKey: string
    runtimeEnvironmentId: typeof runtimeEnvironmentId
    fetchStatus: typeof fetchFolderWorkspacePathStatus
    pending: boolean
  } | null>(null)
  const [completedPathStatusRefreshKeys, setCompletedPathStatusRefreshKeys] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const pathStatusRouteOptions = useMemo(
    () => ({ runtimeEnvironmentId: runtimeEnvironmentId ?? null }),
    [runtimeEnvironmentId]
  )
  const pathStatusCacheKey = pathStatusRequest
    ? getFolderWorkspacePathStatusCacheKey(pathStatusRequest, pathStatusRouteOptions)
    : null
  const pathStatusRefreshKey = pathStatusCacheKey
    ? `${pathStatusCacheKey}:${cacheExpiryTick}`
    : null
  const cachedPathStatusEntry = pathStatusCacheKey
    ? folderWorkspacePathStatuses[pathStatusCacheKey]
    : undefined
  const pathStatus = useMemo(() => {
    if (!pathStatusRequest || pathStatusCacheKey === null) {
      return null
    }
    // Why: subscribe to cache writes, but only let the TTL-aware accessor decide
    // whether a cached negative status is still authoritative.
    void cachedPathStatusEntry
    void cacheExpiryTick
    return getFreshFolderWorkspacePathStatus(pathStatusRequest, pathStatusRouteOptions)
  }, [
    cachedPathStatusEntry,
    cacheExpiryTick,
    getFreshFolderWorkspacePathStatus,
    pathStatusCacheKey,
    pathStatusRequest,
    pathStatusRouteOptions
  ])

  useEffect(() => {
    if (!open || !pathStatusRequest || pathStatusRefreshKey === null || !pathStatusCacheKey) {
      previousPathStatusRefreshRef.current = null
      return
    }
    const previousRefresh = previousPathStatusRefreshRef.current
    const refresh = {
      request: pathStatusRequest,
      cacheKey: pathStatusCacheKey,
      refreshKey: pathStatusRefreshKey,
      runtimeEnvironmentId,
      fetchStatus: fetchFolderWorkspacePathStatus,
      pending: true
    }
    previousPathStatusRefreshRef.current = refresh
    const completeRefresh = (): void => {
      refresh.pending = false
      setCompletedPathStatusRefreshKeys((current) => {
        if (current.has(pathStatusRefreshKey)) {
          return current
        }
        return new Set(current).add(pathStatusRefreshKey)
      })
    }
    // Another folder's expiry does not invalidate this folder's fresh result.
    if (
      previousRefresh?.request === pathStatusRequest &&
      previousRefresh.cacheKey === pathStatusCacheKey &&
      previousRefresh.refreshKey !== pathStatusRefreshKey &&
      previousRefresh.runtimeEnvironmentId === runtimeEnvironmentId &&
      previousRefresh.fetchStatus === fetchFolderWorkspacePathStatus &&
      !previousRefresh.pending &&
      getFreshFolderWorkspacePathStatus(pathStatusRequest, pathStatusRouteOptions) !== null
    ) {
      completeRefresh()
      return
    }
    const refreshId = activePathStatusRefreshIdRef.current + 1
    activePathStatusRefreshIdRef.current = refreshId
    setCompletedPathStatusRefreshKeys((current) => {
      if (!current.has(pathStatusRefreshKey)) {
        return current
      }
      const next = new Set(current)
      next.delete(pathStatusRefreshKey)
      return next
    })
    void Promise.resolve(
      fetchFolderWorkspacePathStatus(pathStatusRequest, { force: true, runtimeEnvironmentId })
    ).finally(() => {
      if (activePathStatusRefreshIdRef.current !== refreshId) {
        return
      }
      completeRefresh()
    })
  }, [
    fetchFolderWorkspacePathStatus,
    getFreshFolderWorkspacePathStatus,
    open,
    pathStatusCacheKey,
    pathStatusRefreshKey,
    pathStatusRequest,
    pathStatusRouteOptions,
    runtimeEnvironmentId
  ])

  const pathStatusRefreshPending =
    open &&
    pathStatusRequest !== null &&
    pathStatusRefreshKey !== null &&
    pathStatus === null &&
    !completedPathStatusRefreshKeys.has(pathStatusRefreshKey)
  const cachedBlockingPathStatus =
    pathStatus === null &&
    cachedPathStatusEntry?.status.exists === false &&
    (isConfirmedStaleFolderPathStatus(cachedPathStatusEntry.status) ||
      cachedPathStatusEntry.status.reason === 'ambiguous-connection')
  const pathStatusBlocksCreate =
    pathStatusRefreshPending ||
    cachedBlockingPathStatus ||
    (pathStatus?.exists === false &&
      (isConfirmedStaleFolderPathStatus(pathStatus) ||
        pathStatus.reason === 'ambiguous-connection'))
  const displayPathStatus =
    pathStatus ?? (cachedBlockingPathStatus ? (cachedPathStatusEntry?.status ?? null) : null)
  const title =
    displayPathStatus?.exists === false
      ? getFolderWorkspacePathStatusTitle(displayPathStatus)
      : null
  const pathStatusProjectError =
    title && displayPathStatus
      ? `${title}. ${getFolderWorkspacePathStatusDescription(displayPathStatus)}`
      : null

  return { pathStatusBlocksCreate, pathStatusProjectError }
}
