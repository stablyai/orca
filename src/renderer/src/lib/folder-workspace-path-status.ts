import { translate } from '@/i18n/i18n'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusReason
} from '../../../shared/folder-workspace-path-status'
import { blocksFolderWorkspaceActivation } from '../../../shared/folder-workspace-path-status'
import { isHandledWireDiscriminant } from '../../../shared/handled-wire-discriminant'

// Why: the status is cast, not decoded, off the runtime RPC wire, so a newer host can send a fifth
// reason. The keys are the union itself, so a new member fails typecheck here and in both switches.
const HANDLED_PATH_STATUS_REASONS: Record<FolderWorkspacePathStatusReason, true> = {
  missing: true,
  'not-directory': true,
  unavailable: true,
  'ambiguous-connection': true
}

// An absent reason is a handled case in both switches; anything else off the wire is not.
function isHandledPathStatusReason(reason: unknown): boolean {
  return reason === undefined || isHandledWireDiscriminant(reason, HANDLED_PATH_STATUS_REASONS)
}

export function getFolderWorkspacePathStatusTitle(
  status: FolderWorkspacePathStatus | null | undefined
): string | null {
  if (!status || status.exists) {
    return null
  }
  // Why: without this the switch matches nothing, returns undefined, and FolderPathStatusIndicator's
  // `!title` check drops the whole marker — a broken folder workspace then renders as healthy.
  if (!isHandledPathStatusReason(status.reason)) {
    return translate(
      'auto.lib.folderWorkspacePathStatus.title.unrecognized',
      'Folder is not usable'
    )
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
  if (!isHandledPathStatusReason(status.reason)) {
    return translate(
      'auto.lib.folderWorkspacePathStatus.description.unrecognized',
      'Orca cannot use {{path}}, and this version does not recognize the reason. Update Orca to see the details.',
      { path: status.path }
    )
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

// IPC wrappers precede the code; ambiguous-connection errors can omit the path.
const FOLDER_WORKSPACE_PATH_ERROR_PATTERN =
  /^([ \t]*(?:Error invoking remote method '[^'\r\n]+': )?(?:Error: )*)folder_workspace_(path_missing|path_not_directory|connection_ambiguous|path_unavailable)(?::([\s\S]*))?$/

export function isFolderWorkspacePathError(message: string): boolean {
  return FOLDER_WORKSPACE_PATH_ERROR_PATTERN.test(message)
}

/** Maps a main-process folder path error code to user-facing copy, or null for anything else. */
export function getFolderWorkspacePathErrorCopy(message: string): {
  title: string
  description: string
} | null {
  const match = FOLDER_WORKSPACE_PATH_ERROR_PATTERN.exec(message)
  if (!match) {
    return null
  }
  const [, , code, path = ''] = match
  switch (code) {
    case 'path_missing':
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
    case 'path_not_directory':
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
    case 'connection_ambiguous':
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
    default:
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
}

export function humanizeFolderWorkspacePathError(message: string): string {
  const copy = getFolderWorkspacePathErrorCopy(message)
  return copy
    ? message.replace(FOLDER_WORKSPACE_PATH_ERROR_PATTERN, (_match, prefix: string) =>
        prefix.concat(copy.description)
      )
    : message
}

export function formatFolderWorkspaceCreateError(error: unknown): {
  title: string
  description: string
} {
  const message = error instanceof Error ? error.message : String(error)
  return (
    getFolderWorkspacePathErrorCopy(message) ?? {
      title: translate(
        'auto.lib.folderWorkspacePathStatus.createError.title.generic',
        'Failed to create folder workspace'
      ),
      description: message
    }
  )
}

export function folderWorkspaceActivationBlocked(
  status: FolderWorkspacePathStatus | null | undefined
): boolean {
  return blocksFolderWorkspaceActivation(status)
}
