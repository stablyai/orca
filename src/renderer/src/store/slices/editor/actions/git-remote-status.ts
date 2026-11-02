import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { tryResolveGitOperationTarget } from './git-operation-target'
import { getRuntimeGitUpstreamStatus } from '@/runtime/runtime-git-sync-client'
import { invalidateAutomaticPushTargetUpstreamStatusCache } from '@/components/right-sidebar/push-target-upstream-refresh-cache'
import { areUpstreamStatusesEqual } from '../git/git-status-reconciliation'

export function createGitRemoteStatus(
  set: EditorSet,
  get: EditorGet
): Pick<
  EditorSlice,
  | 'remoteStatusesByWorktree'
  | 'setUpstreamStatus'
  | 'isRemoteOperationActive'
  | 'remoteOperations'
  | 'beginRemoteOperation'
  | 'fetchUpstreamStatus'
> {
  return {
    remoteStatusesByWorktree: {},
    setUpstreamStatus: (worktreeId, status) =>
      set((s) => {
        if (areUpstreamStatusesEqual(s.remoteStatusesByWorktree[worktreeId], status)) {
          return s
        }
        return {
          remoteStatusesByWorktree: {
            ...s.remoteStatusesByWorktree,
            [worktreeId]: status
          }
        }
      }),
    isRemoteOperationActive: false,
    remoteOperations: [],
    beginRemoteOperation: (kind, worktreeId) => {
      const operation = { kind, worktreeId }
      set((s) => ({
        remoteOperations: [...s.remoteOperations, operation],
        isRemoteOperationActive: true
      }))
      return () =>
        set((s) => {
          const remoteOperations = s.remoteOperations.filter((entry) => entry !== operation)
          return { remoteOperations, isRemoteOperationActive: remoteOperations.length > 0 }
        })
    },
    fetchUpstreamStatus: async (worktreeId, worktreePath, connectionId, pushTarget, options) => {
      const runtimeTarget = tryResolveGitOperationTarget(get(), worktreeId, options)
      if (!runtimeTarget) {
        console.warn('fetchUpstreamStatus skipped: workspace host is unresolved', worktreeId)
        return null
      }
      try {
        const status = await getRuntimeGitUpstreamStatus(
          {
            target: runtimeTarget,
            worktreeId,
            worktreePath,
            connectionId
          },
          pushTarget
        )
        if (options?.applyUpstreamStatus !== false) {
          get().setUpstreamStatus(worktreeId, status)
        }
        return status
      } catch (error) {
        // Retain prior status on error; fake no-upstream flashes Publish and can overwrite real upstream on click.
        if (pushTarget) {
          // Why: don't let an old automatic-poll cache entry suppress the next retry after a transient refresh failure.
          invalidateAutomaticPushTargetUpstreamStatusCache({
            target: runtimeTarget,
            worktreeId,
            worktreePath,
            connectionId,
            pushTarget
          })
        }
        console.error('fetchUpstreamStatus failed', error)
        return null
      }
    }
  }
}
