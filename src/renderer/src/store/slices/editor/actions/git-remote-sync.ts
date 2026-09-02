import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { toast } from 'sonner'
import {
  fetchRuntimeGit,
  getRuntimeGitUpstreamStatus,
  pullRuntimeGit,
  pushRuntimeGit,
  rebaseRuntimeGitFromBase
} from '@/runtime/runtime-git-client'
import {
  markSyncPushStageError,
  resolveRemoteOperationErrorMessage
} from '@/lib/source-control-remote-error'
import { shouldForcePushWithLeaseForUpstream } from '../../../../../../shared/git-upstream-status'

export function createGitRemoteSync(
  _set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'syncBranch' | 'rebaseFromBase' | 'fetchBranch'> {
  return {
    syncBranch: async (worktreeId, worktreePath, connectionId, pushTarget, options) => {
      // Why: like pushBranch — fire-and-forget the post-op upstream refresh so the primary button label rotates immediately.
      get().beginRemoteOperation('sync')
      // Why: the inner push stage toasts as Sync and marks the error so the outer catch skips toasting, avoiding a double-toast.
      let pushStageToastShown = false
      let pushed = false
      const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
      try {
        const context = { settings: runtimeSettings, worktreeId, worktreePath, connectionId }
        await fetchRuntimeGit(context, pushTarget)
        const upstreamStatusBeforePull = await getRuntimeGitUpstreamStatus(context, pushTarget)
        if (shouldForcePushWithLeaseForUpstream(upstreamStatusBeforePull)) {
          try {
            await pushRuntimeGit(context, { pushTarget, forceWithLease: true })
            pushed = true
          } catch (error) {
            toast.error(
              resolveRemoteOperationErrorMessage(error, {
                isSync: true,
                isSyncPushStage: true
              })
            )
            pushStageToastShown = true
            throw markSyncPushStageError(error)
          }
        } else {
          await pullRuntimeGit(context, pushTarget)
          // Why: push only if the pull left local commits ahead of the remote; skip the no-op push after a pure fast-forward.
          const upstreamStatus = await getRuntimeGitUpstreamStatus(context, pushTarget)
          if (upstreamStatus.ahead > 0) {
            try {
              await pushRuntimeGit(context, { pushTarget })
              pushed = true
            } catch (error) {
              // Why: frame as Sync, not the inner push — the user clicked Sync and didn't directly invoke this push.
              toast.error(
                resolveRemoteOperationErrorMessage(error, {
                  isSync: true,
                  isSyncPushStage: true
                })
              )
              pushStageToastShown = true
              throw markSyncPushStageError(error)
            }
          }
        }
      } catch (error) {
        if (!pushStageToastShown) {
          // Why: frame fetch/pull/upstream failures as "Sync failed..." since the user invoked Sync, not the inner step.
          toast.error(resolveRemoteOperationErrorMessage(error, { isSync: true }))
        }
        throw error
      } finally {
        get().endRemoteOperation()
      }
      void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
        runtimeTargetSettings: runtimeSettings
      })
      if (pushed) {
        const refreshGitHubForWorktree = get().refreshGitHubForWorktree
        if (typeof refreshGitHubForWorktree === 'function') {
          refreshGitHubForWorktree(worktreeId)
        }
      }
    },
    rebaseFromBase: async (
      worktreeId,
      worktreePath,
      baseRef,
      connectionId,
      pushTarget,
      options
    ) => {
      get().beginRemoteOperation('rebase')
      const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
      try {
        await rebaseRuntimeGitFromBase(
          { settings: runtimeSettings, worktreeId, worktreePath, connectionId },
          baseRef
        )
      } catch (error) {
        toast.error(resolveRemoteOperationErrorMessage(error, { isRebase: true }))
        throw error
      } finally {
        get().endRemoteOperation()
      }
      void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
        runtimeTargetSettings: runtimeSettings
      })
      const refreshGitHubForWorktree = get().refreshGitHubForWorktree
      if (typeof refreshGitHubForWorktree === 'function') {
        refreshGitHubForWorktree(worktreeId)
      }
    },
    fetchBranch: async (worktreeId, worktreePath, connectionId, pushTarget, options) => {
      // Why: like pushBranch — fire-and-forget the upstream refresh after the busy flag clears so new ahead/behind counts surface.
      get().beginRemoteOperation('fetch')
      const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
      try {
        await fetchRuntimeGit(
          { settings: runtimeSettings, worktreeId, worktreePath, connectionId },
          pushTarget
        )
      } catch (error) {
        toast.error(resolveRemoteOperationErrorMessage(error, { isFetch: true }))
        throw error
      } finally {
        get().endRemoteOperation()
      }
      void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
        runtimeTargetSettings: runtimeSettings
      })
    }
  }
}
