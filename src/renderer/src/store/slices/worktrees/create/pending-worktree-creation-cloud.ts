// Orca Cloud's part of the pending-create store actions: refused rows a new create replaces, the
// failure time the build sheet times a failed step by, and the cancel cleanup record.
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import {
  beginOrcaCloudCancelCleanup,
  isOrcaCloudCreateRequest
} from '@/lib/orca-cloud-cancel-cleanup'
import {
  classifyVmBuildFailure,
  isAccountGate
} from '@/components/worktree-creation/vm-build-failure'

/**
 * An Orca Cloud create refused before anything started (an account
 * limit such as running sandboxes, a plan, sign-in). Its row keeps the prompt with Retry and
 * Dismiss until the person starts another create, which replaces it. A slot freeing up alone
 * never clears it: that would lose the prompt.
 */
export function isStaleRefusedCreation(entry: PendingWorktreeCreation): boolean {
  return (
    entry.status === 'error' &&
    isOrcaCloudCreateRequest(entry.request) &&
    isAccountGate(classifyVmBuildFailure({ entry, error: entry.error ?? null, cloud: true }))
  )
}

/** A new create replaces any stale refused row (nothing started there, so nothing to clean up). */
export function replaceStaleRefusedCreations(get: WorktreeSliceGet, creationId: string): void {
  const stale = Object.values(get().pendingWorktreeCreations).filter(
    (other) => other.creationId !== creationId && isStaleRefusedCreation(other)
  )
  for (const refused of stale) {
    get().removePendingWorktreeCreation(refused.creationId, { cleanupVm: false })
  }
}

/** When this attempt failed, so a failed step can show how long it ran. */
export function nextErrorAt(
  entry: PendingWorktreeCreation,
  patch: Partial<PendingWorktreeCreation>
): number | undefined {
  const status = patch.status ?? entry.status
  if (status !== 'error') {
    return undefined
  }
  return entry.status === 'error' ? entry.errorAt : Date.now()
}

/**
 * A cancelled Orca Cloud create still starting keeps a record of its cleanup (null: it owns no VM
 * yet), so a sandbox that outlives the cancel is noticed.
 */
export function trackOrcaCloudCancelCleanup(
  creationId: string,
  removed: PendingWorktreeCreation,
  cleanup: Promise<boolean> | null
): void {
  if (removed.status === 'creating' && isOrcaCloudCreateRequest(removed.request)) {
    beginOrcaCloudCancelCleanup(creationId, cleanup ? [cleanup] : [], {
      runtimeId: removed.request.ephemeralVmRuntimeId,
      createStartedAt: removed.startedAt,
      canceledAt: Date.now()
    })
  }
}
