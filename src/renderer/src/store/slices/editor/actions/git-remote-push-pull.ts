import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { toast } from 'sonner'
import {
  fetchRuntimeGit,
  pullRuntimeGit,
  pushRuntimeGit,
  fastForwardRuntimeGit
} from '@/runtime/runtime-git-client'
import {
  isNonFastForwardRemoteError,
  resolveRemoteOperationErrorMessage
} from '@/lib/source-control-remote-error'

export function createGitRemotePushPull(
  _set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'pushBranch' | 'pullBranch' | 'fastForwardBranch'> {
  return {
    pushBranch: async (
      worktreeId,
      worktreePath,
      publish = false,
      connectionId,
      pushTarget,
      options = {}
    ) => {
      // Why: fire-and-forget the upstream refresh (don't await) so compound flows aren't delayed, but the "Push"→"Commit" label still rotates faster than the 3s poll.
      get().beginRemoteOperation(
        publish ? 'publish' : options.forceWithLease === true ? 'force_push' : 'push'
      )
      let shouldRefreshAfterRejectedPush = false
      const runtimeSettings = options.runtimeTargetSettings ?? get().settings
      try {
        await pushRuntimeGit(
          { settings: runtimeSettings, worktreeId, worktreePath, connectionId },
          { publish, pushTarget, forceWithLease: options.forceWithLease }
        )
      } catch (error) {
        shouldRefreshAfterRejectedPush = isNonFastForwardRemoteError(error)
        toast.error(
          resolveRemoteOperationErrorMessage(error, {
            publish,
            isPush: !publish && options.forceWithLease !== true,
            isForcePush: !publish && options.forceWithLease === true
          })
        )
        throw error
      } finally {
        get().endRemoteOperation()
        if (shouldRefreshAfterRejectedPush) {
          const context = { settings: runtimeSettings, worktreeId, worktreePath, connectionId }
          // Why: the rejected push proved the branch moved; fetch first so legacy base-tracking worktrees discover origin/<branch>, then refresh ahead/behind.
          void fetchRuntimeGit(context, pushTarget)
            .catch(() => undefined)
            .then(() =>
              get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
                runtimeTargetSettings: runtimeSettings
              })
            )
        }
      }
      void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
        runtimeTargetSettings: runtimeSettings
      })
      const refreshGitHubForWorktree = get().refreshGitHubForWorktree
      if (typeof refreshGitHubForWorktree === 'function') {
        refreshGitHubForWorktree(worktreeId)
      }
    },
    pullBranch: async (worktreeId, worktreePath, connectionId, pushTarget, options) => {
      get().beginRemoteOperation('pull')
      const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
      try {
        await pullRuntimeGit(
          { settings: runtimeSettings, worktreeId, worktreePath, connectionId },
          pushTarget
        )
      } catch (error) {
        toast.error(resolveRemoteOperationErrorMessage(error))
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
    fastForwardBranch: async (worktreeId, worktreePath, connectionId, pushTarget, options) => {
      get().beginRemoteOperation('fast_forward')
      const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
      try {
        await fastForwardRuntimeGit(
          { settings: runtimeSettings, worktreeId, worktreePath, connectionId },
          pushTarget
        )
      } catch (error) {
        toast.error(resolveRemoteOperationErrorMessage(error, { isFastForward: true }))
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
    }
  }
}
