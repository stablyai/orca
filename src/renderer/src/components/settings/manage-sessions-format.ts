import type { PtyManagementSession } from '../../../../preload/api-types'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree-id'

export function shortCwd(cwd: string): string {
  if (!cwd) {
    return 'unknown'
  }
  const separator = cwd.includes('\\') ? '\\' : '/'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join(separator) : cwd
}

export function formatWorkspace(session: { cwd: string | null; sessionId: string }): string {
  if (session.cwd) {
    return shortCwd(session.cwd)
  }
  const sep = session.sessionId.lastIndexOf('@@')
  if (sep !== -1) {
    const worktreeId = session.sessionId.slice(0, sep)
    return shortCwd(splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? worktreeId)
  }
  return 'unknown'
}

export function formatState(session: PtyManagementSession): string {
  if (!session.isAlive) {
    return 'exited'
  }
  if (session.shellState === 'ready') {
    return 'running'
  }
  if (session.shellState === 'pending') {
    return 'starting'
  }
  return session.state
}
