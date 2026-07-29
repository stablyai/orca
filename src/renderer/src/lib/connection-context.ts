import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  getConnectionIdForFileFromState,
  getConnectionIdFromState
} from './connection-owner-resolution'

export { getConnectionIdFromState } from './connection-owner-resolution'

/**
 * Resolve the SSH connectionId for a worktree. Returns null for local repos,
 * the target ID string for remote repos, or undefined if the worktree/repo
 * cannot be found (e.g., store not yet hydrated).
 */
export function getConnectionId(worktreeId: string | null): string | null | undefined {
  return getConnectionIdFromState(useAppStore.getState(), worktreeId)
}

/**
 * True when we can determine the owning host (local vs. a specific SSH target)
 * for a worktree. False means the backing repo has not landed in the store yet
 * — e.g. right after a session restore while the SSH connection is still
 * establishing. Callers must not fall back to a LOCAL read of a remote path in
 * that window; doing so denies the path with a terminal "access denied" (#6648).
 */
export function isWorktreeConnectionResolved(worktreeId: string | null): boolean {
  if (!worktreeId) {
    return true
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    // Folder workspaces resolve per-file; treat them as resolved here and let
    // getConnectionIdForFile decide ownership for the concrete path.
    return true
  }
  // Why: getConnectionId returns undefined only when the backing repo is absent;
  // any found repo yields a string or null, so this mirrors "repo has hydrated".
  return getConnectionId(worktreeId) !== undefined
}

export function getConnectionIdForFile(
  worktreeId: string | null,
  filePath: string
): string | null | undefined {
  return getConnectionIdForFileFromState(useAppStore.getState(), worktreeId, filePath)
}
