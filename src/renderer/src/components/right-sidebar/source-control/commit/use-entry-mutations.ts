import { useCallback } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  notifyEditorExternalFileChange,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { getConnectionId } from '@/lib/connection-context'
import { basename } from '@/lib/path'
import {
  bulkDiscardRuntimeGitPaths,
  bulkUnstageRuntimeGitPaths,
  discardRuntimeGitPath,
  stageRuntimeGitPath,
  unstageRuntimeGitPath
} from '@/runtime/runtime-git-working-tree-client'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import {
  dismissSourceControlEntryFailureToast,
  showSourceControlEntryFailureToast
} from './source-control-entry-failure-toast'

export function useSourceControlEntryMutations({
  activeRepoTarget,
  activeWorktreeId,
  worktreePath,
  refreshActiveGitStatusAfterMutation
}: {
  activeRepoTarget: RuntimeClientTarget | null
  activeWorktreeId: string | null
  worktreePath: string | null
  refreshActiveGitStatusAfterMutation: () => Promise<void>
}) {
  // Name the callback so Retry can reenter the same attempt.
  const runEntryMutation = useCallback(
    async function runEntryMutation(
      operation: 'stage' | 'unstage',
      filePath: string,
      mutate: (context: RuntimeGitContext, filePath: string) => Promise<void>
    ): Promise<void> {
      if (!worktreePath) {
        return
      }
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        await mutate(
          {
            // Route mutations through workspace ownership rather than focused runtime.
            target: requireGitOwnerTarget(activeRepoTarget),
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          filePath
        )
      } catch (error) {
        console.error(`[SourceControl] ${operation} failed`, error)
        showSourceControlEntryFailureToast({
          operation,
          filePath,
          error,
          worktreeId: activeWorktreeId,
          worktreeName: worktreePath ? basename(worktreePath) : null,
          onRetry: () => {
            void runEntryMutation(operation, filePath, mutate)
          }
        })
        return
      }
      // Clear only this worktree's failure slot; another worktree may have filled it while this attempt ran.
      dismissSourceControlEntryFailureToast(activeWorktreeId)
      // Refresh outside the mutation catch so its errors cannot be mislabeled as stage failures.
      await refreshActiveGitStatusAfterMutation()
    },
    [activeRepoTarget, worktreePath, activeWorktreeId, refreshActiveGitStatusAfterMutation]
  )

  const handleStage = useCallback(
    (filePath: string): Promise<void> => runEntryMutation('stage', filePath, stageRuntimeGitPath),
    [runEntryMutation]
  )

  const handleUnstage = useCallback(
    (filePath: string, oldPath?: string): Promise<void> =>
      runEntryMutation(
        'unstage',
        filePath,
        oldPath
          ? (context, path) => bulkUnstageRuntimeGitPaths(context, [path, oldPath])
          : unstageRuntimeGitPath
      ),
    [runEntryMutation]
  )

  // Throw for bulk callers to aggregate; per-row callers report their own failures.
  const discardSingle = useCallback(
    async (filePath: string) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      const runtimeEnvironmentId =
        activeRepoTarget?.kind === 'environment' ? activeRepoTarget.environmentId : null
      // Hold pending autosaves so delayed writes cannot recreate edits after Git restores the file.
      const releaseAutoSave = await requestEditorSaveQuiesce({
        worktreeId: activeWorktreeId,
        worktreePath,
        relativePath: filePath,
        runtimeEnvironmentId
      })
      // Release in finally so every workspace holds autosave until Git finishes.
      try {
        const connectionId = getConnectionId(activeWorktreeId) ?? undefined
        await discardRuntimeGitPath(
          {
            // Route discard through workspace ownership rather than focused runtime.
            target: requireGitOwnerTarget(activeRepoTarget),
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          filePath
        )
        notifyEditorExternalFileChange({
          worktreeId: activeWorktreeId,
          worktreePath,
          relativePath: filePath,
          runtimeEnvironmentId
        })
      } finally {
        releaseAutoSave()
      }
    },
    [activeRepoTarget, activeWorktreeId, worktreePath]
  )

  const discardMany = useCallback(
    async (filePaths: string[]) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      const runtimeEnvironmentId =
        activeRepoTarget?.kind === 'environment' ? activeRepoTarget.environmentId : null
      // Quiesce matching editors so delayed autosaves cannot recreate edits after Git mutates files.
      const quiesced = await Promise.allSettled(
        filePaths.map((relativePath) =>
          requestEditorSaveQuiesce({
            worktreeId: activeWorktreeId,
            worktreePath,
            relativePath,
            runtimeEnvironmentId
          })
        )
      )
      const releases = quiesced.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      )
      const failed = quiesced.find((result) => result.status === 'rejected')
      // If any path cannot quiesce, stop the whole discard and release all holds already acquired.
      if (failed) {
        for (const release of releases) {
          release()
        }
        throw failed.reason
      }
      try {
        const connectionId = getConnectionId(activeWorktreeId) ?? undefined
        await bulkDiscardRuntimeGitPaths(
          {
            // Route discard through workspace ownership rather than focused runtime.
            target: requireGitOwnerTarget(activeRepoTarget),
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          filePaths
        )
        for (const relativePath of filePaths) {
          notifyEditorExternalFileChange({
            worktreeId: activeWorktreeId,
            worktreePath,
            relativePath,
            runtimeEnvironmentId
          })
        }
      } finally {
        for (const release of releases) {
          release()
        }
      }
    },
    [activeRepoTarget, activeWorktreeId, worktreePath]
  )

  return { handleStage, handleUnstage, discardSingle, discardMany }
}
