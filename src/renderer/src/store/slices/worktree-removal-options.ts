import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ConfirmedUnsavedDiscards } from './worktrees/teardown/removed-workspace-unsaved-files'

import type { NestedWorktreeRemovalApproval } from '../../../../shared/worktree/nested-removal'

export type RemoveWorktreeOptions = {
  /** Renderer-only admission check after hook trust, immediately before destructive dispatch. */
  assertBeforeDispatch?: () => void
  approvedNestedWorktrees?: NestedWorktreeRemovalApproval[]
  // forget-local retires renderer state without remote Git/FS work when the pinned SSH host is gone/disconnected.
  mode?: 'remove' | 'forget-local'
  suppressPreservedBranchToast?: boolean
  // Why (#11960): only an explicit Force Delete waives the proof that every
  // PTY stopped; `force` alone is set by the ordinary delete confirmation.
  allowUnverifiedPtyStop?: boolean
  // Only explicit Delete anyway after archive-hook refusal waives it; ordinary confirmation/force never does (#19334).
  allowFailedArchiveHook?: boolean
  snapshotPruneBatchId?: string
  /** Fresh cleanup-scan evidence for a same-id owner not represented in the catalog. */
  sameIdSurvivingHostId?: ExecutionHostId
  /** Both scan owners are in this cleanup batch, so neither is a survivor. */
  ignoreWorkspaceCleanupScanSurvivors?: boolean
  /** The text a dialog listed when the user confirmed discarding it; other edits are offered back. */
  confirmedDiscards?: ConfirmedUnsavedDiscards
}
