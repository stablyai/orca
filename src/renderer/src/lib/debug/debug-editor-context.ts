import {
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../shared/worktree/id'
import { findWorktreeById } from '@/store/slices/worktree-helpers'

export type DebugEditorContext = {
  repoId: string
  rootPath: string
  filePath: string
}

type WorktreesByRepo = Parameters<typeof findWorktreeById>[0]

/** The repo and worktree root a debug session binds to; falls back to the path encoded in the id. */
export function resolveDebugEditorContext(
  state: { worktreesByRepo?: WorktreesByRepo },
  worktreeId: string | undefined,
  filePath: string
): DebugEditorContext | null {
  if (!worktreeId) {
    return null
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const rootPath =
    findWorktreeById(state.worktreesByRepo ?? {}, worktreeId)?.path ??
    splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  return repoId && rootPath ? { repoId, rootPath, filePath } : null
}
