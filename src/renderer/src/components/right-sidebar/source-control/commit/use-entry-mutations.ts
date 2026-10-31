import { useCallback, useRef } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { ConflictResolution } from '../../../../../../shared/source-control-entry-actions'
import { editorFileHoldKey, pathMutationHoldKeys } from '@/components/editor/editor-autosave-holds'
import {
  notifyEditorExternalFileChange,
  requestEditorFileSave,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { getConnectionId } from '@/lib/connection-context'
import { basename } from '@/lib/path'
import { useAppStore } from '@/store'
import {
  bulkDiscardRuntimeGitPaths,
  bulkUnstageRuntimeGitPaths,
  discardRuntimeGitPath,
  resolveRuntimeGitConflict,
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

  const resolvingConflictKeysRef = useRef(new Set<string>())
  const handleResolveConflict = useCallback(
    (entry: GitStatusEntry, resolution: ConflictResolution): Promise<void> => {
      // One resolution per file at a time: a second click could stage before an earlier delete lands.
      const resolvingKey = `${activeWorktreeId}\0${entry.path}`
      if (
        !activeWorktreeId ||
        !worktreePath ||
        !entry.conflictKind ||
        resolvingConflictKeysRef.current.has(resolvingKey)
      ) {
        return Promise.resolve()
      }
      // Staging drops Git's u record; tracking keeps the row's Resolved locally continuity.
      useAppStore.getState().trackConflictPath(activeWorktreeId, entry.path, entry.conflictKind)
      const editorTarget = {
        worktreeId: activeWorktreeId,
        worktreePath,
        relativePath: entry.path,
        runtimeEnvironmentId:
          activeRepoTarget?.kind === 'environment' ? activeRepoTarget.environmentId : null
      }
      const resolve = async (context: RuntimeGitContext, filePath: string): Promise<void> => {
        if (resolution !== 'keep_deletion') {
          // Same view match as autosave holds: every workspace's view of this physical file, not another host's.
          const current = useAppStore.getState()
          const keys = pathMutationHoldKeys(current, editorTarget)
          const dirtyFiles = current.openFiles.filter(
            (file) => file.isDirty && keys.has(editorFileHoldKey(current, file))
          )
          // Stage what the user sees: an unsaved resolution must reach disk before git add reads it.
          await Promise.all(dirtyFiles.map((file) => requestEditorFileSave({ fileId: file.id })))
          await resolveRuntimeGitConflict(context, filePath, resolution)
          return
        }
        // Hold autosave so an open tab cannot recreate the file the host removes.
        const releaseAutoSave = await requestEditorSaveQuiesce(editorTarget)
        try {
          await resolveRuntimeGitConflict(context, filePath, resolution)
          notifyEditorExternalFileChange(editorTarget)
        } finally {
          releaseAutoSave()
        }
      }
      resolvingConflictKeysRef.current.add(resolvingKey)
      return runEntryMutation('stage', entry.path, resolve).finally(() => {
        resolvingConflictKeysRef.current.delete(resolvingKey)
      })
    },
    [activeRepoTarget, activeWorktreeId, runEntryMutation, worktreePath]
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

  return {
    handleStage,
    handleUnstage,
    handleResolveConflict,
    discardSingle,
    discardMany
  }
}
