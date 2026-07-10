import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { isWindowsUserAgent } from './pane-helpers'

export type TerminalTargetShell = 'posix' | 'windows'

export function getTerminalTargetShellForWorktreePath(worktreePath: string): TerminalTargetShell {
  if (isWslUncPath(worktreePath)) {
    return 'posix'
  }
  return isTerminalDropWindowsPathLike(worktreePath) ? 'windows' : 'posix'
}

export function resolveTerminalDropTargetShell({
  activeRuntimeEnvironmentId,
  worktreePath,
  connectionId,
  remotePlatform,
  userAgent
}: {
  activeRuntimeEnvironmentId: string | null | undefined
  worktreePath: string | null | undefined
  connectionId: string | null | undefined
  remotePlatform?: NodeJS.Platform | null
  userAgent?: string
}): TerminalTargetShell {
  if (activeRuntimeEnvironmentId?.trim() && worktreePath) {
    return getTerminalTargetShellForWorktreePath(worktreePath)
  }
  if (typeof connectionId === 'string') {
    return remotePlatform === 'win32' ? 'windows' : 'posix'
  }
  if (worktreePath && isWslUncPath(worktreePath)) {
    return 'posix'
  }
  return isWindowsUserAgent(userAgent) ? 'windows' : 'posix'
}

export function isTerminalDropWindowsPathLike(path: string): boolean {
  if (isWslUncPath(path)) {
    return false
  }
  return isWindowsAbsolutePathLike(path) || path.includes('\\')
}
