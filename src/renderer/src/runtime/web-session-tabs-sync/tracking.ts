import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  latestReceivedSessionTabsInventoryFrameByEnvironment,
  latestReceivedSessionTabsSnapshotByWorktree,
  latestSessionTabsSnapshotByWorktree,
  lastHostTerminalTabCountByWorktree,
  sessionTabsEnvironmentsByWorktree,
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsRemovalWatermarkByWorktree,
  setBoundedSessionTabsReceipt,
  trackedSessionTabsWorktreeIdsByEnvironment,
  nextReceivedSessionTabsFrame,
  sessionTabsFreshnessKey,
  type SnapshotFreshness,
  type SessionTabsListAllResult,
  type TrackedWebSessionTabsWorktree
} from './state'
import {
  acceptSessionTabsRuntimeId,
  isCurrentSessionTabsRuntimeId,
  isRetiredSessionTabsPublicationEpoch,
  isRetiredSessionTabsRuntimeId,
  noteSessionTabsPublicationEpoch,
  recordReceivedWebSessionTabsEnvironmentFrame
} from './publisher-identity-fences'
import { hostSnapshotAffirmsWorktreeContents } from '../host-session-snapshot-authority'
import { replayWebSessionClosesDueForSnapshot } from '../web-session-close-replay'
import { appPairedTerminalTabCloseIntentStore } from '../paired-terminal-tab-close-intent-store'

export function isSessionTabsListAllResult(value: unknown): value is SessionTabsListAllResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as { snapshots?: unknown }).snapshots)
  )
}

export { sessionTabsFreshnessKey } from './state'

export function advancesSessionTabsFreshness(
  snapshot: RuntimeMobileSessionTabsResult,
  baseline: SnapshotFreshness
): boolean {
  return (
    snapshot.publicationEpoch !== baseline.publicationEpoch ||
    snapshot.snapshotVersion > baseline.snapshotVersion
  )
}

export function getTrackedWebSessionTabsWorktrees(
  environmentId: string
): TrackedWebSessionTabsWorktree[] {
  return [...(trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId) ?? [])].flatMap(
    (worktree) => {
      const key = sessionTabsFreshnessKey(environmentId, worktree)
      const freshness = latestSessionTabsSnapshotByWorktree.get(key)
      return freshness
        ? [
            {
              worktree,
              freshness
            }
          ]
        : []
    }
  )
}

export function trackWebSessionTabsWorktree(environmentId: string, worktreeId: string): void {
  const worktrees = trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId) ?? new Set()
  worktrees.add(worktreeId)
  trackedSessionTabsWorktreeIdsByEnvironment.set(environmentId, worktrees)
}

export function untrackWebSessionTabsWorktree(environmentId: string, worktreeId: string): void {
  const worktrees = trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId)
  if (!worktrees) {
    return
  }
  worktrees.delete(worktreeId)
  if (worktrees.size === 0) {
    trackedSessionTabsWorktreeIdsByEnvironment.delete(environmentId)
  }
}

export function recordReceivedWebSessionTabsSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number | undefined = undefined,
  runtimeId?: string,
  source: 'stream' | 'bootstrap' = 'stream'
): number {
  const frame = receivedFrame ?? nextReceivedSessionTabsFrame()
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const current = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  // Bootstrap reserves before request; a later received stream makes its eventual response stale and unable to advance epoch history.
  if (source === 'bootstrap' && current && frame < current.receivedFrame) {
    return frame
  }
  if (runtimeId && !acceptSessionTabsRuntimeId(environmentId, runtimeId, frame)) {
    return frame
  }
  recordReceivedWebSessionTabsEnvironmentFrame(environmentId, frame)
  const publicationEpoch = snapshot.publicationEpoch
  const isRetraction = 'removed' in snapshot && snapshot.removed === true
  const history = sessionTabsPublicationEpochHistoryByWorktree.get(key)
  // Fence retired lineages, not strings; merged predecessors otherwise become current and retire the live successor.
  if (isRetiredSessionTabsPublicationEpoch(key, publicationEpoch)) {
    return frame
  }
  // Unchanged reconnect frames may be filtered before apply; check held closes at receipt, but only authoritative worktree evidence can settle presence.
  if (!isRetraction && hostSnapshotAffirmsWorktreeContents(snapshot)) {
    replayWebSessionClosesDueForSnapshot(
      environmentId,
      snapshot,
      appPairedTerminalTabCloseIntentStore
    )
  }
  // Retraction/unpublished placeholders are no takeover; noting them current retires and locks out the still-live publisher.
  if (
    !isRetraction &&
    hostSnapshotAffirmsWorktreeContents(snapshot) &&
    (!history || history.current !== publicationEpoch)
  ) {
    noteSessionTabsPublicationEpoch(key, publicationEpoch)
  }
  // Stream receipt order wins even if host versions regress; bootstrap lists retain version/epoch ordering and cannot outrank later-received streams.
  if (
    source === 'stream' ||
    !current ||
    current.publicationEpoch !== publicationEpoch ||
    snapshot.snapshotVersion > current.snapshotVersion ||
    (snapshot.snapshotVersion === current.snapshotVersion && current.receivedFrame <= frame)
  ) {
    setBoundedSessionTabsReceipt(
      latestReceivedSessionTabsSnapshotByWorktree,
      key,
      {
        receivedFrame: frame,
        publicationEpoch,
        snapshotVersion: snapshot.snapshotVersion,
        ...(runtimeId ? { runtimeId } : {})
      },
      (entry) => entry.receivedFrame
    )
    if (isRetraction) {
      recordReceivedWebSessionTabsRemoval(environmentId, snapshot.worktree, frame, publicationEpoch)
    }
  }
  return frame
}

export function recordReceivedWebSessionTabsInventory(environmentId: string): number {
  const receivedFrame = nextReceivedSessionTabsFrame()
  recordReceivedWebSessionTabsEnvironmentFrame(environmentId, receivedFrame)
  latestReceivedSessionTabsInventoryFrameByEnvironment.set(environmentId, receivedFrame)
  return receivedFrame
}

export function recordReceivedWebSessionTabsRemoval(
  environmentId: string,
  worktreeId: string,
  receivedFrame: number,
  publicationEpoch: string
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const latest = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  // Retraction is fresh evidence. Record its receipt plus a persistent watermark: later republication overwrites the slot but must not erase the pre-close fence.
  if (!latest || latest.receivedFrame <= receivedFrame) {
    setBoundedSessionTabsReceipt(
      latestReceivedSessionTabsSnapshotByWorktree,
      key,
      { receivedFrame, publicationEpoch, snapshotVersion: 0 },
      (entry) => entry.receivedFrame
    )
  }
  const watermark = sessionTabsRemovalWatermarkByWorktree.get(key) ?? 0
  if (receivedFrame > watermark) {
    sessionTabsRemovalWatermarkByWorktree.set(key, receivedFrame)
  }
}

/** True for a frame whose place in receipt order was fixed before this worktree was last retracted. */
export function precedesWebSessionTabsRemoval(key: string, receivedFrame: number): boolean {
  return receivedFrame < (sessionTabsRemovalWatermarkByWorktree.get(key) ?? 0)
}

export function shouldApplyRecoveredWebSessionTabsSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  runtimeId?: string
): boolean {
  if (
    runtimeId &&
    (isRetiredSessionTabsRuntimeId(environmentId, runtimeId) ||
      !isCurrentSessionTabsRuntimeId(environmentId, runtimeId))
  ) {
    return false
  }
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  if (isRetiredSessionTabsPublicationEpoch(key, snapshot.publicationEpoch)) {
    return false
  }
  if (precedesWebSessionTabsRemoval(key, receivedFrame)) {
    return false
  }

  const latest = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  if (!latest || latest.receivedFrame === receivedFrame) {
    return latest !== undefined
  }
  if (latest.publicationEpoch !== snapshot.publicationEpoch) {
    return receivedFrame > latest.receivedFrame
  }
  return snapshot.snapshotVersion >= latest.snapshotVersion
}

export function recordAcceptedWebSessionTabsEnvironment(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  const environments = new Set(sessionTabsEnvironmentsByWorktree.get(snapshot.worktree) ?? [])
  if (snapshot.tabs.length > 0) {
    environments.add(environmentId)
  } else {
    environments.delete(environmentId)
  }
  if (environments.size > 0) {
    sessionTabsEnvironmentsByWorktree.set(snapshot.worktree, environments)
  } else {
    sessionTabsEnvironmentsByWorktree.delete(snapshot.worktree)
  }
}

export function removeWebSessionTabsEnvironment(environmentId: string, worktreeId: string): void {
  const environments = new Set(sessionTabsEnvironmentsByWorktree.get(worktreeId) ?? [])
  environments.delete(environmentId)
  if (environments.size > 0) {
    sessionTabsEnvironmentsByWorktree.set(worktreeId, environments)
  } else {
    sessionTabsEnvironmentsByWorktree.delete(worktreeId)
  }
}

export function rememberHostTerminalTabCount(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  if (!hostSnapshotAffirmsWorktreeContents(snapshot)) {
    // Why: "ask me later" is not a count of zero; a restarting host may be about to republish.
    lastHostTerminalTabCountByWorktree.delete(key)
    return
  }
  const terminalCount = snapshot.tabs.filter((tab) => tab.type === 'terminal').length
  lastHostTerminalTabCountByWorktree.set(key, terminalCount)
}
