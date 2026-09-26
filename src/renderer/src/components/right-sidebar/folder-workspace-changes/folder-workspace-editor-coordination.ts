import {
  notifyEditorExternalFileChange,
  requestEditorSaveQuiesce,
  type EditorPathMutationTarget
} from '@/components/editor/editor-autosave'

export type FolderWorkspaceEditorCoordinator = {
  /** Quiesce pending autosaves first so a delayed save cannot recreate edits after git restores the files. */
  quiesceSaves: (repoPath: string, relativePaths: readonly string[]) => Promise<void>
  notifyChanged: (repoPath: string, relativePaths: readonly string[]) => void
}

/**
 * Tabs opened from the panel belong to the folder workspace key while their files live in a
 * sibling repo, so editor coordination is addressed by (folder worktree id, repo path, entry path).
 * Without a worktree id no tab can be open, so both operations are no-ops.
 */
export function createFolderWorkspaceEditorCoordinator(args: {
  worktreeId: string | null
  runtimeEnvironmentId: string | null
}): FolderWorkspaceEditorCoordinator {
  const { worktreeId, runtimeEnvironmentId } = args
  const targetFor = (repoPath: string, relativePath: string): EditorPathMutationTarget | null =>
    worktreeId ? { worktreeId, worktreePath: repoPath, relativePath, runtimeEnvironmentId } : null
  return {
    quiesceSaves: async (repoPath, relativePaths) => {
      await Promise.all(
        relativePaths.map((relativePath) => {
          const target = targetFor(repoPath, relativePath)
          return target ? requestEditorSaveQuiesce(target) : Promise.resolve()
        })
      )
    },
    notifyChanged: (repoPath, relativePaths) => {
      for (const relativePath of relativePaths) {
        const target = targetFor(repoPath, relativePath)
        if (target) {
          notifyEditorExternalFileChange(target)
        }
      }
    }
  }
}
