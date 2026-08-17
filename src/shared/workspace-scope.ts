import { parseExecutionHostId, type ExecutionHostId } from './execution-host'
import type { WorkspaceKey, WorkspaceScope } from './folder-workspace-types'

const FOLDER_WORKSPACE_OWNER_KEY_PREFIX = '@owner:'
const FOLDER_WORKSPACE_ESCAPED_ID_PREFIX = '@id:'
const PROJECT_GROUP_KEY_PREFIX = 'project-group:'

type ParsedWorkspaceScope =
  | Extract<WorkspaceScope, { type: 'worktree' }>
  | { type: 'folder'; folderWorkspaceId: string; ownerHostId?: ExecutionHostId }

export function worktreeWorkspaceKey(worktreeId: string): WorkspaceKey {
  return `worktree:${worktreeId}`
}

export function folderWorkspaceKey(
  folderWorkspaceId: string,
  ownerHostId?: ExecutionHostId
): WorkspaceKey {
  if (ownerHostId) {
    return `folder:${FOLDER_WORKSPACE_OWNER_KEY_PREFIX}${encodeURIComponent(ownerHostId)}:${encodeURIComponent(folderWorkspaceId)}`
  }
  if (
    folderWorkspaceId.startsWith(FOLDER_WORKSPACE_OWNER_KEY_PREFIX) ||
    folderWorkspaceId.startsWith(FOLDER_WORKSPACE_ESCAPED_ID_PREFIX)
  ) {
    return `folder:${FOLDER_WORKSPACE_ESCAPED_ID_PREFIX}${encodeURIComponent(folderWorkspaceId)}`
  }
  return `folder:${folderWorkspaceId}`
}

export function parseWorkspaceKey(value: string): ParsedWorkspaceScope | null {
  if (value.startsWith('worktree:')) {
    const worktreeId = value.slice('worktree:'.length)
    return worktreeId.length > 0 ? { type: 'worktree', worktreeId } : null
  }
  if (value.startsWith('folder:')) {
    const rest = value.slice('folder:'.length)
    if (rest.length === 0) {
      return null
    }
    if (rest.startsWith(FOLDER_WORKSPACE_ESCAPED_ID_PREFIX)) {
      try {
        const folderWorkspaceId = decodeURIComponent(
          rest.slice(FOLDER_WORKSPACE_ESCAPED_ID_PREFIX.length)
        )
        return folderWorkspaceId ? { type: 'folder', folderWorkspaceId } : null
      } catch {
        return null
      }
    }
    if (rest.startsWith(FOLDER_WORKSPACE_OWNER_KEY_PREFIX)) {
      const ownerAndWorkspace = rest.slice(FOLDER_WORKSPACE_OWNER_KEY_PREFIX.length)
      const separator = ownerAndWorkspace.indexOf(':')
      if (separator < 1) {
        return null
      }
      try {
        const ownerHostId = parseExecutionHostId(
          decodeURIComponent(ownerAndWorkspace.slice(0, separator))
        )?.id
        const folderWorkspaceId = decodeURIComponent(ownerAndWorkspace.slice(separator + 1))
        return ownerHostId && folderWorkspaceId
          ? { type: 'folder', folderWorkspaceId, ownerHostId }
          : null
      } catch {
        return null
      }
    }
    return { type: 'folder', folderWorkspaceId: rest }
  }
  return null
}

export function getProjectGroupSelectorKey(groupId: string, ownerHostId?: ExecutionHostId): string {
  if (ownerHostId) {
    return `${PROJECT_GROUP_KEY_PREFIX}${FOLDER_WORKSPACE_OWNER_KEY_PREFIX}${encodeURIComponent(ownerHostId)}:${encodeURIComponent(groupId)}`
  }
  if (
    groupId.startsWith(FOLDER_WORKSPACE_OWNER_KEY_PREFIX) ||
    groupId.startsWith(FOLDER_WORKSPACE_ESCAPED_ID_PREFIX)
  ) {
    return `${PROJECT_GROUP_KEY_PREFIX}${FOLDER_WORKSPACE_ESCAPED_ID_PREFIX}${encodeURIComponent(groupId)}`
  }
  return `${PROJECT_GROUP_KEY_PREFIX}${groupId}`
}

export function parseProjectGroupSelectorKey(
  key: string
): { groupId: string; ownerHostId?: ExecutionHostId } | null {
  if (!key.startsWith(PROJECT_GROUP_KEY_PREFIX)) {
    return null
  }
  const value = key.slice(PROJECT_GROUP_KEY_PREFIX.length)
  if (value.startsWith(FOLDER_WORKSPACE_ESCAPED_ID_PREFIX)) {
    try {
      const groupId = decodeURIComponent(value.slice(FOLDER_WORKSPACE_ESCAPED_ID_PREFIX.length))
      return groupId ? { groupId } : null
    } catch {
      return null
    }
  }
  if (!value.startsWith(FOLDER_WORKSPACE_OWNER_KEY_PREFIX)) {
    return value ? { groupId: value } : null
  }
  const ownerAndGroup = value.slice(FOLDER_WORKSPACE_OWNER_KEY_PREFIX.length)
  const separator = ownerAndGroup.indexOf(':')
  if (separator < 1) {
    return null
  }
  try {
    const ownerHostId = parseExecutionHostId(
      decodeURIComponent(ownerAndGroup.slice(0, separator))
    )?.id
    const groupId = decodeURIComponent(ownerAndGroup.slice(separator + 1))
    return ownerHostId && groupId ? { groupId, ownerHostId } : null
  } catch {
    return null
  }
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
    return folderWorkspaceKey(scope.folderWorkspaceId, scope.ownerHostId)
  }
  if (scope?.type === 'worktree') {
    return scope.worktreeId
  }
  return activeWorktreeId
}
