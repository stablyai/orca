import type { ExecutionHostId } from '../../../../shared/execution-host'

/** The rollback target was replaced, so its workspace is already gone. */
export const WORKTREE_INSTANCE_REPLACED_ERROR =
  'Workspace instance changed before cancellation cleanup.'

export type RemoveWorktreeOptions = {
  // 'forget-local' drops the workspace from Orca only (no remote Git/FS work)
  // for workspaces pinned to a removed/disconnected SSH host. Reuses the same
  // renderer-side teardown/purge as a normal remove.
  mode?: 'remove' | 'forget-local'
  suppressPreservedBranchToast?: boolean
  /** Cancellation rolls back an unfinished workspace without running archive hooks. */
  skipArchiveHooks?: boolean
  /** Prevent a delayed creation rollback from removing a replacement at the same path. */
  expectedInstanceId?: string
  // Why (#11960): only an explicit Force Delete waives the proof that every
  // PTY stopped; `force` alone is set by the ordinary delete confirmation.
  allowUnverifiedPtyStop?: boolean
  // Why (#19334): waives a FAILED archive hook. Set only by the explicit "Delete anyway" retry
  // after the user has seen the refusal -- never by the ordinary confirmation, never by `force`.
  allowFailedArchiveHook?: boolean
  snapshotPruneBatchId?: string
  /** Fresh cleanup-scan evidence for a same-id owner not represented in the catalog. */
  sameIdSurvivingHostId?: ExecutionHostId
  /** Both scan owners are in this cleanup batch, so neither is a survivor. */
  ignoreWorkspaceCleanupScanSurvivors?: boolean
}
