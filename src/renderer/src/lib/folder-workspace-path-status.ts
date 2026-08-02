import { translate } from '@/i18n/i18n'
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
      return translate('auto.lib.folderWorkspacePathStatus.title.missing', 'Folder not found')
    case 'not-directory':
      return translate(
        'auto.lib.folderWorkspacePathStatus.title.notDirectory',
        'Path is not a folder'
      )
    case 'ambiguous-connection':
      return translate(
        'auto.lib.folderWorkspacePathStatus.title.ambiguousConnection',
        'Cannot determine connection'
      )
    case undefined:
    case 'unavailable':
      return translate(
        'auto.lib.folderWorkspacePathStatus.title.unavailable',
        'Cannot check folder'
      )
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
      return translate(
        'auto.lib.folderWorkspacePathStatus.description.missing',
        'Orca cannot find {{path}}. Remove and re-import this folder workspace.',
        { path: status.path }
      )
    case 'not-directory':
      return translate(
        'auto.lib.folderWorkspacePathStatus.description.notDirectory',
        '{{path}} exists, but it is not a folder.',
        { path: status.path }
      )
    case 'ambiguous-connection':
      return translate(
        'auto.lib.folderWorkspacePathStatus.description.ambiguousConnection',
        'Orca cannot tell which SSH connection owns this folder scope.'
      )
    case undefined:
    case 'unavailable':
      return translate(
        'auto.lib.folderWorkspacePathStatus.description.unavailable',
        'Orca cannot verify this folder right now. Check the runtime or SSH connection and try again.'
      )
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
      title: translate(
        'auto.lib.folderWorkspacePathStatus.createError.title.missing',
        'Folder not found'
      ),
      description: translate(
        'auto.lib.folderWorkspacePathStatus.createError.description.missing',
        'Orca cannot find {{path}}. Remove and re-import the folder.',
        { path }
      )
    }
  }
  if (message.startsWith('folder_workspace_path_not_directory:')) {
    return {
      title: translate(
        'auto.lib.folderWorkspacePathStatus.createError.title.notDirectory',
        'Path is not a folder'
      ),
      description: translate(
        'auto.lib.folderWorkspacePathStatus.createError.description.notDirectory',
        '{{path}} exists, but it is not a folder.',
        { path }
      )
    }
  }
  if (message.startsWith('folder_workspace_connection_ambiguous:')) {
    return {
      title: translate(
        'auto.lib.folderWorkspacePathStatus.createError.title.ambiguousConnection',
        'Cannot determine connection'
      ),
      description: translate(
        'auto.lib.folderWorkspacePathStatus.createError.description.ambiguousConnection',
        'Orca cannot tell which SSH connection owns this folder scope.'
      )
    }
  }
  if (message.startsWith('folder_workspace_path_unavailable:')) {
    return {
      title: translate(
        'auto.lib.folderWorkspacePathStatus.createError.title.unavailable',
        'Cannot check folder'
      ),
      description: translate(
        'auto.lib.folderWorkspacePathStatus.createError.description.unavailable',
        'Orca cannot verify this folder right now. Check the runtime or SSH connection and try again.'
      )
    }
  }
  return {
    title: translate(
      'auto.lib.folderWorkspacePathStatus.createError.title.generic',
      'Failed to create folder workspace'
    ),
    description: message
  }
}

export function folderWorkspaceActivationBlocked(
  status: FolderWorkspacePathStatus | null | undefined
): boolean {
  return blocksFolderWorkspaceActivation(status)
}
