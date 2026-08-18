/**
 * STA-4343 fail-closed guard: cleanup must never issue a destructive removal
 * against a host other than the one whose row the user confirmed.
 *
 * A cleanup row's `worktreeId` is `repoId::path`, which two execution hosts can
 * both own, while selection, confirmation and preflight all key on `worktreeId`
 * alone and removal routing prefers the ACTIVE workspace's host. This is the
 * minimal safety property: refuse whenever the confirmed owner is unknown, is
 * not the only owner the refreshed scan reports, or is not where the removal
 * would actually land. Routing a colliding row to its right host is #14606.
 */
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { resolveWorkspaceCleanupRemovalHostId } from '../../../../shared/workspace-cleanup-host-identity'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'

/** True only when the removal is provably about to land on the confirmed row's own host. */
export function isWorkspaceCleanupRemovalHostCertain(args: {
  /** The row the user confirmed; internal callers without one fall back to the scanned row. */
  confirmedCandidate: WorkspaceCleanupCandidate | undefined
  scannedCandidate: WorkspaceCleanupCandidate
  /** Every owner the refreshed scan reported for this `worktreeId`, null where a row carries none. */
  scannedHostIds: readonly (ExecutionHostId | null)[]
  /**
   * The host `removeWorktree` would route the destructive IPC to. Null is not a
   * refusal here: `removeWorktree` already fails an unroutable removal closed
   * with WORKTREE_REMOVAL_AMBIGUOUS_ERROR before it touches any transport.
   */
  routeHostId: ExecutionHostId | null
}): boolean {
  const confirmedHostId = resolveWorkspaceCleanupRemovalHostId(
    args.confirmedCandidate ?? args.scannedCandidate
  )
  if (!confirmedHostId) {
    return false
  }
  // Why: one id owned by two hosts cannot say which row was confirmed, and a
  // confirmed owner the refreshed scan no longer reports cannot be verified either.
  const scannedHostIds = new Set(args.scannedHostIds)
  if (scannedHostIds.size !== 1 || !scannedHostIds.has(confirmedHostId)) {
    return false
  }
  return args.routeHostId === null || args.routeHostId === confirmedHostId
}
