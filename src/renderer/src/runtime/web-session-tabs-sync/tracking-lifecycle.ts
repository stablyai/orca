import {
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree,
  latestReceivedSessionTabsSnapshotByWorktree,
  latestReceivedSessionTabsFrameByEnvironment,
  latestReceivedSessionTabsInventoryFrameByEnvironment,
  latestSessionTabsRemovalFenceByWorktree,
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsRuntimeHistoryByEnvironment,
  sessionTabsRecoveryStateByWorktree,
  trackedSessionTabsWorktreeIdsByEnvironment,
  sessionTabsEnvironmentsByWorktree,
  sessionTabsTrackingGenerationByEnvironment,
  lastHostTerminalTabCountByWorktree,
  sessionTabsInventoryOmissionsByWorktree,
  hostSessionTabIdByLocalKey,
  hostSessionTabMappingKeysByEnvironmentAndWorktree,
  hostWorkingClientBoundaryByPaneKey,
  resetReceivedSessionTabsFrameSequence
} from './state'
import {
  clearWebRuntimeWakeTerminalRespawnForWorktree,
  clearAllWebRuntimeWakeTerminalRespawn
} from '../web-runtime-wake-terminal-respawn'
import { clearWebSessionReorderIntentsForWorktree } from '../web-session-reorder-intent'
import { clearWebSessionCloseIntentsForWorktree } from '../web-session-close-intent'
import {
  clearWebAgentSessionHandoffsForWorktree,
  clearWebAgentSessionHandoffsForEnvironment
} from '../web-agent-session-handoff'
import {
  clearWebSessionBrowserPlacementsForWorktree,
  clearWebSessionBrowserPlacementsForEnvironment,
  resetWebSessionBrowserPlacementsForTests
} from '../web-session-browser-placement'
import {
  clearWebSessionTerminalPlacementsForWorktree,
  clearWebSessionTerminalPlacementsForEnvironment
} from '../web-session-terminal-placement'
import { clearHostSessionMirrorHydration } from '../host-session-mirror-hydration'
import { clearHostSessionTabIdMappings } from './tracking-mappings'
import {
  sessionTabsFreshnessKey,
  untrackWebSessionTabsWorktree,
  removeWebSessionTabsEnvironment
} from './tracking'

export function getLastKnownHostTerminalTabCount(
  environmentId: string,
  worktreeId: string
): number {
  return (
    lastHostTerminalTabCountByWorktree.get(sessionTabsFreshnessKey(environmentId, worktreeId)) ?? 0
  )
}

export function getLatestWebSessionTabsPublicationEpoch(
  environmentId: string,
  worktreeId: string
): string | null {
  return (
    latestSessionTabsSnapshotByWorktree.get(sessionTabsFreshnessKey(environmentId, worktreeId))
      ?.publicationEpoch ?? null
  )
}

// Why: a replay may repeat the current epoch/version; permit only that exact
// identity once so an older concurrent frame cannot bypass monotonic ordering.
export function acceptReplayedWebSessionTabsSnapshot(
  environmentId: string,
  worktreeId: string
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const current = latestSessionTabsSnapshotByWorktree.get(key)
  if (current) {
    replayableSessionTabsSnapshotByWorktree.set(key, current)
  }
}
export function resetWebSessionTabsSnapshotFreshnessForTests(): void {
  latestSessionTabsSnapshotByWorktree.clear()
  replayableSessionTabsSnapshotByWorktree.clear()
  latestReceivedSessionTabsSnapshotByWorktree.clear()
  sessionTabsRuntimeHistoryByEnvironment.clear()
  sessionTabsPublicationEpochHistoryByWorktree.clear()
  latestReceivedSessionTabsFrameByEnvironment.clear()
  latestReceivedSessionTabsInventoryFrameByEnvironment.clear()
  latestSessionTabsRemovalFenceByWorktree.clear()
  sessionTabsRecoveryStateByWorktree.clear()
  trackedSessionTabsWorktreeIdsByEnvironment.clear()
  sessionTabsEnvironmentsByWorktree.clear()
  resetReceivedSessionTabsFrameSequence()
  lastHostTerminalTabCountByWorktree.clear()
  sessionTabsInventoryOmissionsByWorktree.clear()
  hostSessionTabIdByLocalKey.clear()
  hostSessionTabMappingKeysByEnvironmentAndWorktree.clear()
  hostWorkingClientBoundaryByPaneKey.clear()
  resetWebSessionBrowserPlacementsForTests()
}

export function _getWebSessionTabsTrackingCountsForTest(): {
  freshness: number
  hostMappings: number
  hostMappingWorktrees: number
} {
  let hostMappingWorktrees = 0
  for (const mappingKeysByWorktree of hostSessionTabMappingKeysByEnvironmentAndWorktree.values()) {
    hostMappingWorktrees += mappingKeysByWorktree.size
  }
  return {
    freshness: latestSessionTabsSnapshotByWorktree.size,
    hostMappings: hostSessionTabIdByLocalKey.size,
    // Why: the mapping index is a parallel structure, so leak tests must see it drain alongside the flat map.
    hostMappingWorktrees
  }
}

export function _getWebSessionTabsRecoveryTrackingCountsForTest(): {
  pendingRecoveries: number
  removalFrames: number
} {
  return {
    pendingRecoveries: sessionTabsRecoveryStateByWorktree.size,
    removalFrames: latestSessionTabsRemovalFenceByWorktree.size
  }
}

export function clearWebSessionTabsTrackingForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  latestSessionTabsSnapshotByWorktree.delete(key)
  replayableSessionTabsSnapshotByWorktree.delete(key)
  latestReceivedSessionTabsSnapshotByWorktree.delete(key)
  // Keep the bounded epoch history as a tombstone fence. A sibling stream can
  // still deliver an old frame after this removal has cleared the live view.
  untrackWebSessionTabsWorktree(environmentId, worktreeId)
  removeWebSessionTabsEnvironment(environmentId, worktreeId)
  lastHostTerminalTabCountByWorktree.delete(key)
  sessionTabsInventoryOmissionsByWorktree.delete(key)
  clearWebRuntimeWakeTerminalRespawnForWorktree(worktreeId)
  clearWebSessionReorderIntentsForWorktree({ environmentId }, worktreeId)
  clearWebSessionCloseIntentsForWorktree({ environmentId }, worktreeId)
  clearWebAgentSessionHandoffsForWorktree(environmentId, worktreeId)
  clearHostSessionTabIdMappings(environmentId, worktreeId)
  clearWebSessionBrowserPlacementsForWorktree(environmentId, worktreeId)
  clearWebSessionTerminalPlacementsForWorktree(environmentId, worktreeId)
}

export function clearWebSessionTabsTrackingForEnvironment(environmentId: string): void {
  const trimmedEnvironmentId = environmentId.trim()
  if (!trimmedEnvironmentId) {
    return
  }
  const keyPrefix = `${trimmedEnvironmentId}:`
  sessionTabsTrackingGenerationByEnvironment.set(
    trimmedEnvironmentId,
    (sessionTabsTrackingGenerationByEnvironment.get(trimmedEnvironmentId) ?? 0) + 1
  )
  for (const key of latestSessionTabsSnapshotByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      latestSessionTabsSnapshotByWorktree.delete(key)
    }
  }
  for (const key of replayableSessionTabsSnapshotByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      replayableSessionTabsSnapshotByWorktree.delete(key)
    }
  }
  for (const key of latestReceivedSessionTabsSnapshotByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      latestReceivedSessionTabsSnapshotByWorktree.delete(key)
    }
  }
  sessionTabsRuntimeHistoryByEnvironment.delete(trimmedEnvironmentId)
  for (const key of sessionTabsPublicationEpochHistoryByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      sessionTabsPublicationEpochHistoryByWorktree.delete(key)
    }
  }
  latestReceivedSessionTabsFrameByEnvironment.delete(trimmedEnvironmentId)
  latestReceivedSessionTabsInventoryFrameByEnvironment.delete(trimmedEnvironmentId)
  for (const key of latestSessionTabsRemovalFenceByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      latestSessionTabsRemovalFenceByWorktree.delete(key)
    }
  }
  for (const key of sessionTabsRecoveryStateByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      sessionTabsRecoveryStateByWorktree.delete(key)
    }
  }
  trackedSessionTabsWorktreeIdsByEnvironment.delete(trimmedEnvironmentId)
  for (const worktreeId of sessionTabsEnvironmentsByWorktree.keys()) {
    removeWebSessionTabsEnvironment(trimmedEnvironmentId, worktreeId)
  }
  for (const key of lastHostTerminalTabCountByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      lastHostTerminalTabCountByWorktree.delete(key)
    }
  }
  for (const key of sessionTabsInventoryOmissionsByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      sessionTabsInventoryOmissionsByWorktree.delete(key)
    }
  }
  const mappingKeysByWorktree =
    hostSessionTabMappingKeysByEnvironmentAndWorktree.get(trimmedEnvironmentId)
  if (mappingKeysByWorktree) {
    for (const mappingKeys of mappingKeysByWorktree.values()) {
      for (const mappingKey of mappingKeys) {
        hostSessionTabIdByLocalKey.delete(mappingKey)
      }
    }
    hostSessionTabMappingKeysByEnvironmentAndWorktree.delete(trimmedEnvironmentId)
  }
  clearWebAgentSessionHandoffsForEnvironment(trimmedEnvironmentId)
  clearWebSessionBrowserPlacementsForEnvironment(trimmedEnvironmentId)
  clearWebSessionTerminalPlacementsForEnvironment(trimmedEnvironmentId)
  clearHostSessionMirrorHydration(trimmedEnvironmentId)
  clearAllWebRuntimeWakeTerminalRespawn()
}

export function getWebSessionTabsTrackingGeneration(environmentId: string): number {
  return sessionTabsTrackingGenerationByEnvironment.get(environmentId.trim()) ?? 0
}
