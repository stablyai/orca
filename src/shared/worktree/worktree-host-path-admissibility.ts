import { isWindowsAbsolutePathLike } from '../cross-platform-path'
import { isWslUncPath } from '../wsl-paths'
import type { Repo } from '../repo-types'
import type { ExecutionHostId } from '../execution-host'

export type WorktreeHostTarget =
  | Pick<Repo, 'path'> & Partial<Pick<Repo, 'connectionId' | 'executionHostId'>>
  | { hostId?: ExecutionHostId; path?: string }

/**
 * Validates whether a worktree path is syntactically admissible for the execution host.
 * Cross-host git repositories (e.g. Windows host bind-mounted into a Linux dev container)
 * can report alien paths from the foreign OS or mangled paths joined onto .git/worktrees.
 */
export function isWorktreePathAdmissibleForHost(
  worktreePath: string | undefined | null,
  target: WorktreeHostTarget,
  platform = process.platform
): boolean {
  if (!worktreePath || typeof worktreePath !== 'string') {
    return false
  }

  // Worktree checkout paths cannot reside inside administrative .git directories.
  if (
    worktreePath.includes('/.git/') ||
    worktreePath.includes('\\.git\\') ||
    worktreePath.endsWith('/.git') ||
    worktreePath.endsWith('\\.git')
  ) {
    return false
  }

  // Paths with a colon after index 1 indicate joined drive paths (e.g. /.../.git/worktrees/.../C:/...).
  if (worktreePath.slice(2).includes(':')) {
    return false
  }

  const isSsh = Boolean(
    ('connectionId' in target && target.connectionId) ||
      ('hostId' in target && typeof target.hostId === 'string' && target.hostId.startsWith('ssh:'))
  )
  const isWindowsHost =
    Boolean(target.path && isWindowsAbsolutePathLike(target.path) && !isWslUncPath(target.path)) ||
    (!isSsh && platform === 'win32' && !(target.path && isWslUncPath(target.path)))

  if (isWindowsHost) {
    // POSIX root paths cannot exist as native Windows absolute paths.
    if (worktreePath.startsWith('/') && !worktreePath.startsWith('//')) {
      return false
    }
    return isWindowsAbsolutePathLike(worktreePath) || isWslUncPath(worktreePath)
  }

  // POSIX hosts cannot resolve Windows drive-letter paths or backslash separators.
  if (isWindowsAbsolutePathLike(worktreePath) && !isWslUncPath(worktreePath)) {
    return false
  }
  if (/^[A-Za-z]:[\\/]/.test(worktreePath) || (!isWslUncPath(worktreePath) && worktreePath.includes('\\'))) {
    return false
  }

  return (worktreePath.startsWith('/') && !worktreePath.startsWith('//')) || isWslUncPath(worktreePath)
}
