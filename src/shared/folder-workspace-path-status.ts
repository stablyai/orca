export type FolderWorkspacePathStatusReason =
  | 'missing'
  | 'not-directory'
  | 'unavailable'
  | 'ambiguous-connection'

export const FOLDER_WORKSPACE_PATH_STATUS_TTL_MS = 10_000

export type FolderWorkspacePathStatusRequest =
  | { scope: 'folder-workspace'; folderWorkspaceId: string }
  | { scope: 'project-group'; projectGroupId: string }

export type FolderWorkspacePathStatus = {
  path: string
  exists: boolean
  reason?: FolderWorkspacePathStatusReason
}

export function isConfirmedStaleFolderPathStatus(
  status: FolderWorkspacePathStatus | null | undefined
): boolean {
  return (
    status?.exists === false && (status.reason === 'missing' || status.reason === 'not-directory')
  )
}

export function blocksFolderWorkspaceActivation(
  status: FolderWorkspacePathStatus | null | undefined
): boolean {
  return (
    isConfirmedStaleFolderPathStatus(status) ||
    (status?.exists === false && status.reason === 'ambiguous-connection')
  )
}
