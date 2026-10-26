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

/** Require two omissions for unlabeled/unverifiable censuses; a declined authority label is only visibility evidence (confirmSurfaceInventoryAbsence). */
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

// Why: a tombstone empties its host's whole share of a worktree mirror, so it is a visibility fact,
// never evidence that the host closed anything.
export function isWebSessionTabsWorktreeRemovalFrame(
  snapshot: RuntimeMobileSessionTabsResult
): boolean {
  return (
    (snapshot as { removed?: unknown }).removed === true ||
    snapshot.publicationEpoch === VISIBILITY_INVENTORY_REMOVAL_EPOCH
  )
}

// Tombstones need mirror-settle evidence: one authoritative PTY census omission suffices.
// Unlabelled degraded/version-skewed inventories must repeat before destroying anything.
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
