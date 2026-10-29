import { isTerminalDropWindowsPathLike } from '../../../../shared/image-path-paste'
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
  userAgent
}: {
  activeRuntimeEnvironmentId: string | null | undefined
  worktreePath: string | null | undefined
  connectionId: string | null | undefined
  userAgent?: string
}): TerminalTargetShell {
  if (activeRuntimeEnvironmentId?.trim() && worktreePath) {
    return getTerminalTargetShellForWorktreePath(worktreePath)
  }
  // Why: only a relay-era SSH row still has a connectionId, and its pane cannot accept input.
  if (typeof connectionId === 'string') {
    return 'posix'
  }
  if (worktreePath && isWslUncPath(worktreePath)) {
    return 'posix'
  }
  return isWindowsUserAgent(userAgent) ? 'windows' : 'posix'
}
