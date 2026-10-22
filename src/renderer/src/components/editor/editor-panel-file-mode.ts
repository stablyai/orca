import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { findWorktreeById } from '@/store/slices/worktree-helpers'

export function isAbsolutePathLike(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)
}

export function canUseChangesModeForFile(file: OpenFile): boolean {
  return (
    file.mode === 'edit' &&
    !file.isUntitled &&
    file.relativePath !== file.filePath &&
    !isAbsolutePathLike(file.relativePath)
  )
}

// Why: folder repos have no history; unresolved worktrees (folder workspaces) fall through and the host returns no blame.
export function canUseGitBlameForFile(
  state: Pick<AppState, 'worktreesByRepo' | 'repos'>,
  file: OpenFile
): boolean {
  if (!canUseChangesModeForFile(file)) {
    return false
  }
  const repoId = findWorktreeById(state.worktreesByRepo, file.worktreeId)?.repoId
  const repo = repoId ? state.repos.find((candidate) => candidate.id === repoId) : undefined
  return !repo || !isFolderRepo(repo)
}
