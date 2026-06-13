import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useFolderWorkspacePathStatusCacheExpiryTick } from '@/lib/folder-workspace-path-status-cache-expiry'
import {
  getFolderWorkspacePathStatusDescription,
  getFolderWorkspacePathStatusTitle
} from '@/lib/folder-workspace-path-status'
import { isConfirmedStaleFolderPathStatus } from '../../../../shared/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../shared/types'

export function useFolderWorkspaceComposerPathStatus(
  projectGroup: ProjectGroup | null,
  open: boolean
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
  const pathStatus = useMemo(() => {
    if (!pathStatusRequest) {
      return null
    }
    const cacheKey = getFolderWorkspacePathStatusCacheKey(pathStatusRequest)
    // Why: subscribe to cache writes, but only let the TTL-aware accessor decide
    // whether a cached negative status is still authoritative.
    void folderWorkspacePathStatuses[cacheKey]
    void cacheExpiryTick
    return getFreshFolderWorkspacePathStatus(pathStatusRequest)
  }, [
    folderWorkspacePathStatuses,
    cacheExpiryTick,
    getFolderWorkspacePathStatusCacheKey,
    getFreshFolderWorkspacePathStatus,
    pathStatusRequest
  ])

  useEffect(() => {
    if (!open || !pathStatusRequest) {
      return
    }
    void fetchFolderWorkspacePathStatus(pathStatusRequest, { force: true })
  }, [fetchFolderWorkspacePathStatus, open, pathStatusRequest])

  const pathStatusBlocksCreate =
    pathStatus?.exists === false &&
    (isConfirmedStaleFolderPathStatus(pathStatus) || pathStatus.reason === 'ambiguous-connection')
  const title = pathStatus?.exists === false ? getFolderWorkspacePathStatusTitle(pathStatus) : null
  const pathStatusProjectError =
    title && pathStatus ? `${title}. ${getFolderWorkspacePathStatusDescription(pathStatus)}` : null

  return { pathStatusBlocksCreate, pathStatusProjectError }
}
