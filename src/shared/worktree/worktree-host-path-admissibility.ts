import { isWindowsAbsolutePathLike } from '../cross-platform-path'
import { isWslUncPath } from '../wsl-paths'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../execution-host'

/** A repo row or project host setup: the host that owns a checkout and that host's repo path. */
export type WorktreeHostTarget = {
  path?: string | null
  hostId?: string | null
  connectionId?: string | null
  executionHostId?: string | null
}

type HostPathSyntax = 'windows' | 'wsl' | 'posix'

function hostPathSyntax(
  target: WorktreeHostTarget,
  platform: NodeJS.Platform
): HostPathSyntax | null {
  const repoPath = target.path ?? ''
  // Why the owning host's own repo path: an SSH or runtime host's OS is not carried on the row, and
  // the client platform says nothing about it (a Windows client drives Linux hosts and vice versa).
  if (isWslUncPath(repoPath)) {
    return 'wsl'
  }
  if (isWindowsAbsolutePathLike(repoPath)) {
    return 'windows'
  }
  if (repoPath.startsWith('/')) {
    return 'posix'
  }
  const hostId = normalizeExecutionHostId(target.hostId) ?? getRepoExecutionHostId(target)
  if (hostId !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  return platform === 'win32' ? 'windows' : 'posix'
}

function isPosixAbsolutePath(path: string): boolean {
  return path.startsWith('/') && !isWindowsAbsolutePathLike(path)
}

// Why: a POSIX git cannot parse a foreign `C:/…` gitdir and joins it onto
// `<common dir>/worktrees/<id>/`; a bare common dir need not be named `.git`. Without the real
// common dir, a POSIX checkout literally at `…/worktrees/<x>/C:/…` is also rejected (accepted cost).
export const JOINED_FOREIGN_REGISTRATION = /\/worktrees\/[^/]+\/([A-Za-z]:[\\/].*)$/

/** A checkout never lives inside a git admin dir. A bare repo's own `.git` entry is not inside it. */
function isInsideGitAdminDir(path: string): boolean {
  // Why the split: `\` is a separator only in Windows spellings; on POSIX it is a name character.
  // A WSL listing reaches here in its translated `\\wsl.localhost\…` spelling.
  return isWindowsAbsolutePathLike(path)
    ? /[\\/]\.git[\\/]|[\\/]worktrees[\\/][^\\/]+[\\/][A-Za-z]:[\\/]/.test(path)
    : path.includes('/.git/') || JOINED_FOREIGN_REGISTRATION.test(path)
}

/**
 * Whether `worktreePath` can be a checkout on the host that owns `target`. Two hosts sharing one
 * .git (a Windows folder bind-mounted into a Linux container) see each other's registrations,
 * either as foreign absolute paths or joined onto the admin dir (issue #21764).
 */
export function isWorktreePathAdmissibleForHost(
  worktreePath: string | undefined | null,
  target: WorktreeHostTarget,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!worktreePath) {
    return false
  }
  if (isInsideGitAdminDir(worktreePath)) {
    return false
  }
  switch (hostPathSyntax(target, platform)) {
    case 'windows':
      return isWindowsAbsolutePathLike(worktreePath)
    case 'wsl':
      // Why drive paths too: WSL reaches them via /mnt/<drive>, and listing translates those back.
      return isWindowsAbsolutePathLike(worktreePath) || isPosixAbsolutePath(worktreePath)
    case 'posix':
      return isPosixAbsolutePath(worktreePath)
    case null:
      return true
  }
}
