import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  getConnectionIdForFileFromState,
  getConnectionIdFromState
} from './connection-owner-resolution'

export { getConnectionIdFromState } from './connection-owner-resolution'

/** Return SSH target, null for resolved local, or undefined while ownership is unknown. */
export function getConnectionId(worktreeId: string | null): string | null | undefined {
  return getConnectionIdFromState(useAppStore.getState(), worktreeId)
}

/** Require resolved ownership before file reads; hydration gaps must not fall back to local access of remote paths (#6648). */
export function isWorktreeConnectionResolved(worktreeId: string | null): boolean {
  if (!worktreeId) {
    return true
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    // Folder ownership is per-file; defer it to getConnectionIdForFile.
    return true
  }
  // A found repo always yields string/null; undefined means it has not hydrated.
  return getConnectionId(worktreeId) !== undefined
}

export function getConnectionIdForFile(
  worktreeId: string | null,
  filePath: string
): string | null | undefined {
  return getConnectionIdForFileFromState(useAppStore.getState(), worktreeId, filePath)
}
