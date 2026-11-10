// "Move to this computer": window ↔ main contract. Two steps so the local workspace is created by
// the window's ordinary worktree-create path: prepare (pack in the VM over orcad, download, fetch
// the branch into the local repo) then finish (apply changes, install chats into the new worktree).
export type CloudTransferPhase =
  | 'packing'
  | 'downloading'
  | 'importing'
  | 'creating-worktree'
  | 'applying'
  | 'done'
  | 'failed'

export type CloudTransferProgressEvent = {
  workspaceId: string
  transferId: string | null
  phase: CloudTransferPhase
  /** Downloaded / total bytes while downloading. */
  bytes?: number
  totalBytes?: number
  message?: string
  at: number
}

export type CloudTransferPrepared = {
  transferId: string
  /** Local project the cloud workspace was created from; the window creates the worktree there. */
  repoId: string
  /** Local branch now holding the cloud branch's commits (renamed if the name was taken). */
  branch: string
  cloudBranch: string | null
  baseBranch: string | null
  counts: {
    untrackedFiles: number
    claudeSessions: number
    codexSessions: number
    hasChanges: boolean
  }
}

export type CloudTransferFinished = {
  worktreePath: string
  appliedStaged: boolean
  appliedUnstaged: boolean
  untrackedFiles: number
  claudeSessions: number
  codexSessions: number
  /** Patches that did not apply cleanly were saved here instead of being dropped. */
  leftoverPatchDir: string | null
  /** Files the saved patches touch that changed here since; the patch was not forced onto them. */
  conflicts?: string[]
  /** Untracked files not written because something is already at that path. */
  skippedUntracked?: string[]
}

export type CloudTransferResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

export type OrcaCloudTransferApi = {
  prepareTransferToLocal: (args: {
    workspaceId: string
    destination?: { repoId?: string }
  }) => Promise<CloudTransferResult<CloudTransferPrepared>>
  finishTransferToLocal: (args: {
    transferId: string
    worktreePath: string
  }) => Promise<CloudTransferResult<CloudTransferFinished>>
  /** "Apply changes again" onto the same local worktree after a partial or failed apply. */
  reapplyTransferToLocal: (args: {
    transferId: string
    worktreePath: string
  }) => Promise<CloudTransferResult<CloudTransferFinished>>
  onTransferProgress: (callback: (event: CloudTransferProgressEvent) => void) => () => void
}

export const ORCA_CLOUD_TRANSFER_CHANNELS = {
  prepare: 'orcaCloudWorkspace:prepareTransferToLocal',
  finish: 'orcaCloudWorkspace:finishTransferToLocal',
  reapply: 'orcaCloudWorkspace:reapplyTransferToLocal',
  progress: 'orcaCloudWorkspace:transferProgress'
} as const
