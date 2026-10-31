export type PerforceFileAction =
  | 'add'
  | 'edit'
  | 'delete'
  | 'branch'
  | 'integrate'
  | 'move/add'
  | 'move/delete'
  | 'archive'
  | 'purge'
  | 'import'
  | 'unknown'

/** `opened`: checked out; `modified`: changed on disk but not opened; `new`: not in the depot. */
export type PerforceEntryGroup = 'opened' | 'modified' | 'new'

export type PerforceEntry = {
  /** Workspace-relative path with forward slashes. */
  path: string
  depotPath?: string
  action: PerforceFileAction
  group: PerforceEntryGroup
  /** Pending changelist number; 'default' for the default changelist. Only set on opened files. */
  changelist?: 'default' | number
  fileType?: string
}

export type PerforceShelvedFile = {
  depotPath: string
  /** Workspace-relative path; absent when the file is not mapped into this client. */
  path?: string
  action: PerforceFileAction
}

export type PerforceChangelist = {
  id: number
  description: string
  /** Files stored in the changelist's shelf; empty when nothing is shelved. */
  shelvedFiles: PerforceShelvedFile[]
}

export type PerforceWorkspaceInfo = {
  client: string
  user: string
  port: string
  root: string
  stream?: string
  /** Latest submitted changelist synced into the workspace, when known. */
  haveChange?: number
}

export type PerforceStatusResult = {
  info: PerforceWorkspaceInfo
  entries: PerforceEntry[]
  changelists: PerforceChangelist[]
}

export type PerforceHistoryEntry = {
  change: number
  user: string
  client: string
  /** Unix seconds. */
  time: number
  description: string
}

export type PerforceOperationResult = { success: boolean; output: string; error?: string }

export type PerforceDetectResult =
  | { isWorkspace: true; info: PerforceWorkspaceInfo }
  | { isWorkspace: false; reason: 'p4-not-found' | 'not-in-workspace' | 'error'; message?: string }
