import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { FolderWorkspacePathStatus } from '../../../../shared/folder-workspace-path-status'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import type { RepoSlice } from '../repos/repo-state'
import {
  getFolderWorkspacePathStatusRequestSnapshotForRead,
  getFolderWorkspaceStatusRequestSnapshot,
  getFreshFolderWorkspacePathStatusFromCache
} from './folder-path-status'
import {
  getFolderWorkspacePathStatusRouteSettings,
  getFolderWorkspacePathStatusScopeKey,
  getRuntimeTargetCachePrefix
} from './folder-workspace-routing'

export function createFolderPathStatusActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<
  RepoSlice,
  | 'getFolderWorkspacePathStatusCacheKey'
  | 'getFreshFolderWorkspacePathStatus'
  | 'fetchFolderWorkspacePathStatus'
> {
  return {
    getFolderWorkspacePathStatusCacheKey: (request, options) =>
      `${getRuntimeTargetCachePrefix(
        getFolderWorkspacePathStatusRouteSettings(options, get().settings)
      )}:${getFolderWorkspacePathStatusScopeKey(request)}`,

    getFreshFolderWorkspacePathStatus: (request, options) => {
      const state = get()
      const cacheKey = get().getFolderWorkspacePathStatusCacheKey(request, options)
      const cached = state.folderWorkspacePathStatuses[cacheKey]
      const requestSnapshot = getFolderWorkspacePathStatusRequestSnapshotForRead(state, request)
      return getFreshFolderWorkspacePathStatusFromCache({ entry: cached, requestSnapshot })
    },

    fetchFolderWorkspacePathStatus: async (request, options) => {
      const cacheKey = get().getFolderWorkspacePathStatusCacheKey(request, options)
      const requestSnapshot = getFolderWorkspaceStatusRequestSnapshot(get(), request)
      const cached = get().folderWorkspacePathStatuses[cacheKey]
      const freshCachedStatus = getFreshFolderWorkspacePathStatusFromCache({
        entry: cached,
        requestSnapshot
      })
      if (!options?.force && freshCachedStatus) {
        return freshCachedStatus
      }
      try {
        const target = getActiveRuntimeTarget(
          getFolderWorkspacePathStatusRouteSettings(options, get().settings)
        )
        const status =
          target.kind === 'local'
            ? await window.api.folderWorkspaces.getPathStatus(request)
            : (
                await callRuntimeRpc<{ status: FolderWorkspacePathStatus }>(
                  target,
                  'folderWorkspace.getPathStatus',
                  request,
                  { timeoutMs: 15_000 }
                )
              ).status
        set((state) => ({
          folderWorkspacePathStatuses:
            requestSnapshot !== null &&
            getFolderWorkspaceStatusRequestSnapshot(state, request) === requestSnapshot
              ? {
                  ...state.folderWorkspacePathStatuses,
                  [cacheKey]: { status, checkedAt: Date.now(), requestSnapshot }
                }
              : state.folderWorkspacePathStatuses
        }))
        return status
      } catch (err) {
        console.error('Failed to fetch folder workspace path status:', err)
        return null
      }
    }
  }
}
