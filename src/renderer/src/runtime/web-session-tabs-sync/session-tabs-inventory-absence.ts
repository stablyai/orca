import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import {
  MAX_TRACKED_SESSION_TABS_INVENTORY_OMISSIONS,
  VISIBILITY_INVENTORY_REMOVAL_EPOCH,
  latestSessionTabsSnapshotByWorktree,
  sessionTabsInventoryOmissionsByWorktree,
  type TrackedWebSessionTabsWorktree
} from './state'
import { sessionTabsFreshnessKey } from './tracking'

function omissionKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}:${worktreeId}`
}

function trackedWorktreeOmissionFingerprint(
  trackedWorktree: TrackedWebSessionTabsWorktree
): string {
  return [
    trackedWorktree.freshness.publicationEpoch,
    trackedWorktree.freshness.snapshotVersion
  ].join('\0')
}

export function clearTrackedWebSessionTabsInventoryAbsence(
  environmentId: string,
  worktreeId: string
): void {
  sessionTabsInventoryOmissionsByWorktree.delete(omissionKey(environmentId, worktreeId))
}

/**
 * Returns true only after two inventories omit the same tracked identity,
 * mirroring `confirmSurfaceInventoryAbsence`. One omission from a census the
 * host declined to label authoritative is a visibility fact, never attestation
 * that the worktree is gone.
 */
export function confirmTrackedWebSessionTabsInventoryAbsence(
  environmentId: string,
  trackedWorktree: TrackedWebSessionTabsWorktree
): boolean {
  const key = omissionKey(environmentId, trackedWorktree.worktree)
  const fingerprint = trackedWorktreeOmissionFingerprint(trackedWorktree)
  const cached = sessionTabsInventoryOmissionsByWorktree.get(key)
  const observations = cached?.fingerprint === fingerprint ? cached.observations + 1 : 1
  sessionTabsInventoryOmissionsByWorktree.delete(key)
  sessionTabsInventoryOmissionsByWorktree.set(key, {
    fingerprint,
    observations: Math.min(observations, 2)
  })
  while (
    sessionTabsInventoryOmissionsByWorktree.size > MAX_TRACKED_SESSION_TABS_INVENTORY_OMISSIONS
  ) {
    const oldest = sessionTabsInventoryOmissionsByWorktree.keys().next().value
    if (typeof oldest !== 'string') {
      break
    }
    sessionTabsInventoryOmissionsByWorktree.delete(oldest)
  }
  return observations >= 2
}

export function isTrackedWebSessionTabsOmissionCurrent(
  environmentId: string,
  trackedWorktree: TrackedWebSessionTabsWorktree
): boolean {
  const key = sessionTabsFreshnessKey(environmentId, trackedWorktree.worktree)
  const current = latestSessionTabsSnapshotByWorktree.get(key)
  return (
    current?.publicationEpoch === trackedWorktree.freshness.publicationEpoch &&
    current.snapshotVersion === trackedWorktree.freshness.snapshotVersion
  )
}

// Why: a tombstone empties the whole worktree mirror — including tabs a still-live sibling environment publishes — so it is a
// visibility fact, never evidence that the host closed anything.
export function isWebSessionTabsWorktreeRemovalFrame(
  snapshot: RuntimeMobileSessionTabsResult
): boolean {
  return (
    (snapshot as { removed?: unknown }).removed === true ||
    snapshot.publicationEpoch === VISIBILITY_INVENTORY_REMOVAL_EPOCH
  )
}

/**
 * Why: a tombstone empties a whole worktree mirror, so it needs the same host
 * evidence `mirror-settle` already demands before it will settle an empty
 * inventory. An inventory the host labels `authoritative` carries a complete
 * PTY census, so one omission is attestation. An unlabelled inventory is a
 * degraded or version-skewed census — `unverifiable`, not `exited` — so it must
 * repeat before it can destroy anything.
 */
export function buildMissingWebSessionTabsRemovals(
  environmentId: string,
  trackedWorktrees: readonly TrackedWebSessionTabsWorktree[],
  publishedWorktrees: ReadonlySet<string>,
  hostAuthoritative: boolean
): {
  trackedWorktree: TrackedWebSessionTabsWorktree
  snapshot: RuntimeMobileSessionTabsRemovedResult
}[] {
  return trackedWorktrees
    .filter((trackedWorktree) => {
      if (publishedWorktrees.has(trackedWorktree.worktree)) {
        clearTrackedWebSessionTabsInventoryAbsence(environmentId, trackedWorktree.worktree)
        return false
      }
      if (!isTrackedWebSessionTabsOmissionCurrent(environmentId, trackedWorktree)) {
        return false
      }
      if (hostAuthoritative) {
        clearTrackedWebSessionTabsInventoryAbsence(environmentId, trackedWorktree.worktree)
        return true
      }
      return confirmTrackedWebSessionTabsInventoryAbsence(environmentId, trackedWorktree)
    })
    .map((trackedWorktree) => ({
      trackedWorktree,
      snapshot: {
        worktree: trackedWorktree.worktree,
        publicationEpoch: VISIBILITY_INVENTORY_REMOVAL_EPOCH,
        snapshotVersion: 0,
        removed: true,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    }))
}
