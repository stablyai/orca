import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'

const REMOTE_FLOATING_PREFIX = `${FLOATING_TERMINAL_WORKTREE_ID}:runtime:`

export function floatingWorkspaceId(environmentId: string | null): string {
  return environmentId
    ? `${REMOTE_FLOATING_PREFIX}${encodeURIComponent(environmentId)}`
    : FLOATING_TERMINAL_WORKTREE_ID
}

export function floatingWorkspaceEnvironmentId(
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId?.startsWith(REMOTE_FLOATING_PREFIX)) {
    return null
  }
  try {
    return decodeURIComponent(worktreeId.slice(REMOTE_FLOATING_PREFIX.length)) || null
  } catch {
    return null
  }
}

export function isFloatingWorkspaceId(worktreeId: string | null | undefined): boolean {
  return (
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    floatingWorkspaceEnvironmentId(worktreeId) !== null
  )
}
