import { useCallback } from 'react'
import {
  notifyEditorExternalFileChange,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { getConnectionId } from '@/lib/connection-context'
import {
  bulkDiscardRuntimeGitPaths,
  discardRuntimeGitPath,
  stageRuntimeGitPath,
  unstageRuntimeGitPath,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'

export function useSourceControlEntryMutations({
  activeRepoSettings,
  activeWorktreeId,
  worktreePath,
  refreshActiveGitStatusAfterMutation
}: {
  activeRepoSettings: RuntimeGitContext['settings']
  activeWorktreeId: string | null
  worktreePath: string | null
  refreshActiveGitStatusAfterMutation: () => Promise<void>
}) {
  const handleStage = useCallback(
    async (filePath: string) => {
      if (!worktreePath) {
        return
      }
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        await stageRuntimeGitPath(
          {
            // Why: route staging by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          filePath
        )
        await refreshActiveGitStatusAfterMutation()
      } catch (error) {
        console.error('[SourceControl] stage failed', error)
      }
    },
    [activeRepoSettings, worktreePath, activeWorktreeId, refreshActiveGitStatusAfterMutation]
  )

  const handleUnstage = useCallback(
    async (filePath: string) => {
      if (!worktreePath) {
        return
      }
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        await unstageRuntimeGitPath(
          {
            // Why: route unstaging by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          filePath
        )
        await refreshActiveGitStatusAfterMutation()
      } catch (error) {
        console.error('[SourceControl] unstage failed', error)
      }
    },
    [activeRepoSettings, worktreePath, activeWorktreeId, refreshActiveGitStatusAfterMutation]
  )

  // Why: discardSingle throws so bulk callers can aggregate failures into one toast; handleDiscard swallows for per-row fire-and-forget.
  const discardSingle = useCallback(
    async (filePath: string) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      const runtimeEnvironmentId =
        useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() || null
      // Why: quiesce pending editor autosaves first so a delayed save can't recreate the discarded edits after git restores the file.
      await requestEditorSaveQuiesce({
        worktreeId: activeWorktreeId,
        worktreePath,
        relativePath: filePath,
        runtimeEnvironmentId
      })
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      await discardRuntimeGitPath(
        {
          // Why: route the discard by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
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
    },
    [activeRepoSettings, activeWorktreeId, worktreePath]
  )

  const discardMany = useCallback(
    async (filePaths: string[]) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      const runtimeEnvironmentId =
        useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() || null
      // Why: quiesce matching editor autosaves first so a delayed save can't recreate edits after git mutates the files.
      await Promise.all(
        filePaths.map((relativePath) =>
          requestEditorSaveQuiesce({
            worktreeId: activeWorktreeId,
            worktreePath,
            relativePath,
            runtimeEnvironmentId
          })
        )
      )
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      await bulkDiscardRuntimeGitPaths(
        {
          // Why: route the discard by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
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
    },
    [activeRepoSettings, activeWorktreeId, worktreePath]
  )

  return { handleStage, handleUnstage, discardSingle, discardMany }
}
