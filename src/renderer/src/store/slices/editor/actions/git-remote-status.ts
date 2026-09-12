import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { getRuntimeGitUpstreamStatus } from '@/runtime/runtime-git-client'
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
  | 'remoteOperationDepth'
  | 'inFlightRemoteOpKind'
  | 'beginRemoteOperation'
  | 'endRemoteOperation'
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
    remoteOperationDepth: 0,
    inFlightRemoteOpKind: null,
    beginRemoteOperation: (kind) =>
      set((s) => ({
        remoteOperationDepth: s.remoteOperationDepth + 1,
        isRemoteOperationActive: true,
        // Why: last-write-wins on the kind; the UI blocks a second user-initiated op, so the most recent kind matches what the user is watching.
        inFlightRemoteOpKind: kind ?? s.inFlightRemoteOpKind
      })),
    endRemoteOperation: () =>
      set((s) => {
        const next = Math.max(0, s.remoteOperationDepth - 1)
        return {
          remoteOperationDepth: next,
          isRemoteOperationActive: next > 0,
          // Why: keep the in-flight kind (its label/spinner) until depth reaches 0 and no remote op remains.
          inFlightRemoteOpKind: next > 0 ? s.inFlightRemoteOpKind : null
        }
      }),
    fetchUpstreamStatus: async (worktreeId, worktreePath, connectionId, pushTarget, options) => {
      const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
      try {
        const status = await getRuntimeGitUpstreamStatus(
          {
            settings: runtimeSettings,
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
        // Why: keep prior status on error — a synthetic {hasUpstream:false} would flash 'Publish Branch' on a tracked branch and a click could re-publish, clobbering the upstream.
        if (pushTarget) {
          // Why: don't let an old automatic-poll cache entry suppress the next retry after a transient refresh failure.
          invalidateAutomaticPushTargetUpstreamStatusCache({
            settings: runtimeSettings,
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
