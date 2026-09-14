import type { ExecutionHostId } from '../../../../shared/execution-host'

export type RemoveWorktreeOptions = {
  // 'forget-local' drops the workspace from Orca only (no remote Git/FS work)
  // for workspaces pinned to a removed/disconnected SSH host. Reuses the same
  // renderer-side teardown/purge as a normal remove.
  mode?: 'remove' | 'forget-local'
  suppressPreservedBranchToast?: boolean
  // Why (#11960): only an explicit Force Delete waives the proof that every
  // PTY stopped; `force` alone is set by the ordinary delete confirmation.
  allowUnverifiedPtyStop?: boolean
  snapshotPruneBatchId?: string
  /** Fresh cleanup-scan evidence for a same-id owner not represented in the catalog. */
  sameIdSurvivingHostId?: ExecutionHostId
  /** Both scan owners are in this cleanup batch, so neither is a survivor. */
  ignoreWorkspaceCleanupScanSurvivors?: boolean
}
