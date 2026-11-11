// Cloud → this computer file sync for Orca Cloud workspaces: `.context` (on by default) and an
// optional read-only mirror of the whole workspace. Main owns the sync; the window shows state.

export const ORCA_CLOUD_SYNC_CHANNELS = {
  getState: 'orcaCloudSync:getState',
  setChoice: 'orcaCloudSync:setChoice',
  openFolder: 'orcaCloudSync:openFolder',
  retry: 'orcaCloudSync:retry',
  removalPreview: 'orcaCloudSync:removalPreview',
  changed: 'orcaCloudSync:changed'
} as const

export type CloudSyncChoiceState = { context: boolean; mirror: boolean }

export type CloudSyncPhase =
  /** Both rows off: nothing on this computer. */
  | 'off'
  /** First pass in flight, nothing copied yet. */
  | 'starting'
  | 'copying'
  | 'synced'
  /** The sandbox is asleep (or not reachable from here): the copy stays, sync resumes on wake. */
  | 'waiting'
  | 'error'

export type CloudSyncLimitsInfo = { maxBytes: number; maxFileBytes: number }

export type CloudSyncState = {
  workspaceId: string
  choice: CloudSyncChoiceState
  /** Absolute folder (`~/orca/cloud/<repository>/<workspace>`). */
  folder: string
  phase: CloudSyncPhase
  files: number
  bytes: number
  progress: { done: number; total: number } | null
  lastSyncedAt: number | null
  /** Copies changed on this computer (they don't sync back). */
  editedHere: number
  /** Cloud files over the per-file limit. */
  skippedLarge: number
  /** Files past the folder's limit. */
  overLimit: number
  limits: CloudSyncLimitsInfo
  /** English detail for "Copy log"; the UI shows the glossary sentence. */
  error: string | null
}

export type CloudSyncView = CloudSyncState & {
  /** What "Open folder" opens and the folder line shows (`~/…`). */
  openPath: string
  displayPath: string
}

/** What archive/delete would remove from this computer (for the confirmation line). */
export type CloudSyncRemovalPreview = { hasLocalCopy: boolean; editedHere: number }

export type CloudSyncApi = {
  getState: (workspaceId: string) => Promise<CloudSyncView | null>
  setChoice: (args: {
    workspaceId: string
    context?: boolean
    mirror?: boolean
  }) => Promise<CloudSyncView | null>
  openFolder: (workspaceId: string) => Promise<{ ok: boolean }>
  retry: (workspaceId: string) => Promise<void>
  removalPreview: (workspaceId: string) => Promise<CloudSyncRemovalPreview>
  onChanged: (listener: (view: CloudSyncView) => void) => () => void
}
