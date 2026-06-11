import type { FolderWorkspacePathStatus } from '../../../shared/folder-workspace-path-status'
import { blocksFolderWorkspaceActivation } from '../../../shared/folder-workspace-path-status'

export function getFolderWorkspacePathStatusTitle(
  status: FolderWorkspacePathStatus | null | undefined
): string | null {
  if (!status || status.exists) {
    return null
  }
  switch (status.reason) {
    case 'missing':
      return 'Folder not found'
    case 'not-directory':
      return 'Path is not a folder'
    case 'ambiguous-connection':
      return 'Cannot determine connection'
    case 'unavailable':
    default:
      return 'Cannot check folder'
  }
}

export function getFolderWorkspacePathStatusDescription(
  status: FolderWorkspacePathStatus | null | undefined
): string | null {
  if (!status || status.exists) {
    return null
  }
  switch (status.reason) {
    case 'missing':
      return `Orca cannot find ${status.path}. Remove and re-import this folder workspace.`
    case 'not-directory':
      return `${status.path} exists, but it is not a folder.`
    case 'ambiguous-connection':
      return 'Orca cannot tell which SSH connection owns this folder scope.'
    case 'unavailable':
    default:
      return 'Orca cannot verify this folder right now. Check the runtime or SSH connection and try again.'
  }
}

export function formatFolderWorkspaceCreateError(error: unknown): {
  title: string
  description: string
} {
  const message = error instanceof Error ? error.message : String(error)
  const path = message.includes(':') ? message.slice(message.indexOf(':') + 1) : ''
  if (message.startsWith('folder_workspace_path_missing:')) {
    return {
      title: 'Folder not found',
      description: `Orca cannot find ${path}. Remove and re-import the folder.`
    }
  }
  if (message.startsWith('folder_workspace_path_not_directory:')) {
    return {
      title: 'Path is not a folder',
      description: `${path} exists, but it is not a folder.`
    }
  }
  if (message.startsWith('folder_workspace_connection_ambiguous:')) {
    return {
      title: 'Cannot determine connection',
      description: 'Orca cannot tell which SSH connection owns this folder scope.'
    }
  }
  if (message.startsWith('folder_workspace_path_unavailable:')) {
    return {
      title: 'Cannot check folder',
      description:
        'Orca cannot verify this folder right now. Check the runtime or SSH connection and try again.'
    }
  }
  return { title: 'Failed to create folder workspace', description: message }
}

export function folderWorkspaceActivationBlocked(
  status: FolderWorkspacePathStatus | null | undefined
): boolean {
  return blocksFolderWorkspaceActivation(status)
}
