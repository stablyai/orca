import type { WorkspaceKey, WorkspaceScope } from './folder-workspace-types'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from './worktree/host-qualified-identity'

export function worktreeWorkspaceKey(worktreeId: string): WorkspaceKey {
  return `worktree:${worktreeId}`
}

export function folderWorkspaceKey(folderWorkspaceId: string): WorkspaceKey {
  return `folder:${folderWorkspaceId}`
}

export function parseWorkspaceKey(value: string): WorkspaceScope | null {
  if (value.startsWith('worktree:')) {
    const worktreeId = value.slice('worktree:'.length)
    return worktreeId.length > 0 ? { type: 'worktree', worktreeId } : null
  }
  if (value.startsWith('folder:')) {
    const folderWorkspaceId = value.slice('folder:'.length)
    return folderWorkspaceId.length > 0 ? { type: 'folder', folderWorkspaceId } : null
  }
  return null
}

/** Bare workspace id behind a session key, which may be a WorkspaceKey, a host-qualified identity
 *  (`ssh:target|repo::path`, used by visit recency), or already a bare id. */
export function normalizeWorkspaceSessionKeyToWorkspaceId(value: string): string {
  if (isWorktreeHostIdentity(value)) {
    return getWorktreeIdFromHostIdentity(value)
  }
  const scope = parseWorkspaceKey(value)
  return scope?.type === 'worktree' ? scope.worktreeId : value
}

export function isWorkspaceKey(value: string): value is WorkspaceKey {
  return parseWorkspaceKey(value) !== null
}

// Why: folder workspaces are tracked by the scoped active key, while older
// worktree-only paths still read activeWorktreeId.
export function getActiveSidebarWorkspaceId(
  activeWorkspaceKey: string | null,
  activeWorktreeId: string | null
): string | null {
  const scope = activeWorkspaceKey ? parseWorkspaceKey(activeWorkspaceKey) : null
  if (scope?.type === 'folder') {
    return folderWorkspaceKey(scope.folderWorkspaceId)
  }
  if (scope?.type === 'worktree') {
    return scope.worktreeId
  }
  return activeWorktreeId
}
