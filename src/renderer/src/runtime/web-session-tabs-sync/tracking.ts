import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  latestReceivedSessionTabsInventoryFrameByEnvironment,
  latestReceivedSessionTabsSnapshotByWorktree,
  latestSessionTabsRemovalFenceByWorktree,
  latestSessionTabsSnapshotByWorktree,
  lastHostTerminalTabCountByWorktree,
  sessionTabsEnvironmentsByWorktree,
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsRecoveryStateByWorktree,
  trackedSessionTabsWorktreeIdsByEnvironment,
  nextReceivedSessionTabsFrame,
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

export function isSessionTabsListAllResult(value: unknown): value is SessionTabsListAllResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as { snapshots?: unknown }).snapshots)
  )
}

export function sessionTabsFreshnessKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}:${worktreeId}`
}

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
  // A bootstrap listAll reserves its frame before the request starts. If a
  // stream frame for this worktree arrived meanwhile, the late list is stale
  // evidence and must not advance epoch history.
  if (source === 'bootstrap' && current && frame < current.receivedFrame) {
    return frame
  }
  if (runtimeId && !acceptSessionTabsRuntimeId(environmentId, runtimeId, frame)) {
    return frame
  }
  recordReceivedWebSessionTabsEnvironmentFrame(environmentId, frame)
  const publicationEpoch = snapshot.publicationEpoch
  const history = sessionTabsPublicationEpochHistoryByWorktree.get(key)
  const isRetired = history?.retired.includes(publicationEpoch) ?? false
  if (isRetired) {
    return frame
  }
  if (!history || history.current !== publicationEpoch) {
    noteSessionTabsPublicationEpoch(key, publicationEpoch)
  }
  // Stream delivery order is the freshest evidence even when a host's version
  // counter briefly moves backwards (for example across a visibility resume).
  // Bootstrap listAll responses retain version/epoch ordering so a late
  // response cannot replace a stream frame received after the request began.
  if (
    source === 'stream' ||
    !current ||
    current.publicationEpoch !== publicationEpoch ||
    snapshot.snapshotVersion > current.snapshotVersion ||
    (snapshot.snapshotVersion === current.snapshotVersion && current.receivedFrame <= frame)
  ) {
    latestReceivedSessionTabsSnapshotByWorktree.set(key, {
      receivedFrame: frame,
      publicationEpoch,
      snapshotVersion: snapshot.snapshotVersion,
      ...(runtimeId ? { runtimeId } : {})
    })
    if ((snapshot as { removed?: unknown }).removed === true) {
      recordReceivedWebSessionTabsRemoval(environmentId, snapshot.worktree, frame)
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

export function beginWebSessionTabsSnapshotRecovery(
  environmentId: string,
  worktreeId: string,
  receivedFrame: number
): () => void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const recoveryState = sessionTabsRecoveryStateByWorktree.get(key) ?? { pendingCount: 0 }
  recoveryState.pendingCount += 1
  sessionTabsRecoveryStateByWorktree.set(key, recoveryState)
  let settled = false
  return () => {
    if (settled) {
      return
    }
    settled = true
    recoveryState.pendingCount -= 1
    if (
      recoveryState.pendingCount === 0 &&
      sessionTabsRecoveryStateByWorktree.get(key) === recoveryState
    ) {
      sessionTabsRecoveryStateByWorktree.delete(key)
    }
    const removalFence = latestSessionTabsRemovalFenceByWorktree.get(key)
    if (
      removalFence?.recoveryState === recoveryState &&
      receivedFrame < removalFence.receivedFrame
    ) {
      removalFence.pendingCount -= 1
      if (removalFence.pendingCount === 0) {
        latestSessionTabsRemovalFenceByWorktree.delete(key)
      }
    }
  }
}

export function recordReceivedWebSessionTabsRemoval(
  environmentId: string,
  worktreeId: string,
  receivedFrame: number
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const current = latestSessionTabsRemovalFenceByWorktree.get(key)
  if (current && current.receivedFrame >= receivedFrame) {
    return
  }
  const recoveryState = sessionTabsRecoveryStateByWorktree.get(key)
  if (!recoveryState || recoveryState.pendingCount === 0) {
    latestSessionTabsRemovalFenceByWorktree.delete(key)
    return
  }
  latestSessionTabsRemovalFenceByWorktree.set(key, {
    receivedFrame,
    recoveryState,
    pendingCount: recoveryState.pendingCount
  })
  // An inventory omission/removal is a new visibility boundary. A later live
  // frame may legitimately restart its version counter, while recoveries
  // queued before this boundary are fenced by receivedFrame above.
  latestReceivedSessionTabsSnapshotByWorktree.delete(key)
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
  const removalFrame = latestSessionTabsRemovalFenceByWorktree.get(key)?.receivedFrame
  if (removalFrame !== undefined && receivedFrame < removalFrame) {
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
  const terminalCount = snapshot.tabs.filter((tab) => tab.type === 'terminal').length
  lastHostTerminalTabCountByWorktree.set(key, terminalCount)
}
