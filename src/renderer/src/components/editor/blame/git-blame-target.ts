import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { getFolderFileConnectionOwnerFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'

const openFileIndexes = new WeakMap<readonly OpenFile[], Map<string, OpenFile>>()

/** O(1) per store write: the index is rebuilt only when `openFiles` changes identity. */
export function openFileById(openFiles: readonly OpenFile[], fileId: string): OpenFile | undefined {
  let index = openFileIndexes.get(openFiles)
  if (!index) {
    index = new Map(openFiles.map((file) => [file.id, file]))
    openFileIndexes.set(openFiles, index)
  }
  return index.get(fileId)
}

export type GitBlameTarget = { git: RuntimeGitContext; relativePath: string }

/**
 * The repo that owns the file. Folder workspaces resolve the child repo, so git runs against a
 * registered repo root and its HEAD signal is the child's worktree id.
 */
export function resolveGitBlameTarget(state: AppState, file: OpenFile): GitBlameTarget | null {
  const scope = parseWorkspaceKey(file.worktreeId)
  try {
    if (scope?.type !== 'folder') {
      const worktreePath = file.filePath.slice(
        0,
        file.filePath.length - file.relativePath.length - 1
      )
      const { target, connectionId } = getEditorFileReadContext(state, file, worktreePath)
      return {
        git: { target, worktreeId: file.worktreeId, worktreePath, connectionId },
        relativePath: file.relativePath
      }
    }
    const repo = getFolderFileConnectionOwnerFromState(
      state,
      scope.folderWorkspaceId,
      file.filePath
    )?.repo
    if (!repo || file.filePath.length <= repo.path.length) {
      return null
    }
    const { target, connectionId } = getEditorFileReadContext(state, file, repo.path)
    const worktreeId =
      selectWorktreesByRepo(state)[repo.id]?.find((worktree) => worktree.path === repo.path)?.id ??
      null
    // Remote calls address the repo by worktree id; without one only the local route works.
    if (!worktreeId && target.kind !== 'local') {
      return null
    }
    return {
      git: { target, worktreeId, worktreePath: repo.path, connectionId },
      relativePath: file.filePath.slice(repo.path.length + 1)
    }
  } catch {
    // The file's owner is unresolved or changed; blame stays hidden.
    return null
  }
}
