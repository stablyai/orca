import {
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree,
  latestReceivedSessionTabsSnapshotByWorktree,
  latestReceivedSessionTabsFrameByEnvironment,
  latestReceivedSessionTabsInventoryFrameByEnvironment,
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsRemovalWatermarkByWorktree,
  sessionTabsRuntimeHistoryByEnvironment,
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
import {
  endWebRuntimeInitialTerminalBootstrap,
  clearWebRuntimeInitialTerminalBootstrapsForEnvironment
} from '../web-runtime-initial-terminal-bootstrap'
import { clearWebSessionReorderIntentsForWorktree } from '../web-session-reorder-intent'
import { clearWebSessionCloseIntentsForWorktree } from '../web-session-close-intent'
import { clearWebSessionCustomTitleIntentsForWorktree } from '../web-session-custom-title-intent'
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
import { clearHostMirrorHandleGapVerdictsForEnvironment } from '@/lib/host-mirror-handle-gap-wait'
import { clearHostSessionTabIdMappings } from './tracking-mappings'
import {
  sessionTabsFreshnessKey,
  untrackWebSessionTabsWorktree,
  removeWebSessionTabsEnvironment
} from './tracking'

const MAX_SESSION_TABS_TRACKING_GENERATIONS = 512
let sessionTabsTrackingGenerationSequence = 0
let evictedSessionTabsTrackingGeneration = 0

function advanceSessionTabsTrackingGeneration(environmentId: string): void {
  const next = ++sessionTabsTrackingGenerationSequence
  sessionTabsTrackingGenerationByEnvironment.set(environmentId, next)
  while (sessionTabsTrackingGenerationByEnvironment.size > MAX_SESSION_TABS_TRACKING_GENERATIONS) {
    const oldest = sessionTabsTrackingGenerationByEnvironment.keys().next()
    if (oldest.done) {
      break
    }
    const oldestEnvironmentId = oldest.value
    evictedSessionTabsTrackingGeneration = Math.max(
      evictedSessionTabsTrackingGeneration,
      sessionTabsTrackingGenerationByEnvironment.get(oldestEnvironmentId) ?? 0
    )
    sessionTabsTrackingGenerationByEnvironment.delete(oldestEnvironmentId)
  }
}

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
  sessionTabsRemovalWatermarkByWorktree.clear()
  trackedSessionTabsWorktreeIdsByEnvironment.clear()
  sessionTabsEnvironmentsByWorktree.clear()
  resetReceivedSessionTabsFrameSequence()
  lastHostTerminalTabCountByWorktree.clear()
  sessionTabsInventoryOmissionsByWorktree.clear()
  hostSessionTabIdByLocalKey.clear()
  hostSessionTabMappingKeysByEnvironmentAndWorktree.clear()
  hostWorkingClientBoundaryByPaneKey.clear()
  sessionTabsTrackingGenerationByEnvironment.clear()
  sessionTabsTrackingGenerationSequence = 0
  evictedSessionTabsTrackingGeneration = 0
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

export function _getWebSessionTabsReceiptTrackingCountsForTest(): {
  receipts: number
  removalWatermarks: number
} {
  return {
    receipts: latestReceivedSessionTabsSnapshotByWorktree.size,
    removalWatermarks: sessionTabsRemovalWatermarkByWorktree.size
  }
}

export function clearWebSessionTabsTrackingForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  latestSessionTabsSnapshotByWorktree.delete(key)
  replayableSessionTabsSnapshotByWorktree.delete(key)
  // The receipt ledger and removal watermark are deliberately kept: they order a delayed
  // predecessor frame against the live publisher's next one, which is the whole point of a
  // retraction. Clearing the live view is this function's job; forgetting what was received is not.
  untrackWebSessionTabsWorktree(environmentId, worktreeId)
  removeWebSessionTabsEnvironment(environmentId, worktreeId)
  lastHostTerminalTabCountByWorktree.delete(key)
  sessionTabsInventoryOmissionsByWorktree.delete(key)
  clearWebRuntimeWakeTerminalRespawnForWorktree(worktreeId)
  endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
  clearWebSessionReorderIntentsForWorktree({ environmentId }, worktreeId)
  clearWebSessionCloseIntentsForWorktree({ environmentId }, worktreeId)
  clearWebSessionCustomTitleIntentsForWorktree(environmentId, worktreeId)
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
  advanceSessionTabsTrackingGeneration(trimmedEnvironmentId)
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
  for (const key of sessionTabsRemovalWatermarkByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      sessionTabsRemovalWatermarkByWorktree.delete(key)
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
  clearHostMirrorHandleGapVerdictsForEnvironment(trimmedEnvironmentId)
  clearAllWebRuntimeWakeTerminalRespawn()
  clearWebRuntimeInitialTerminalBootstrapsForEnvironment(trimmedEnvironmentId)
}

export function getWebSessionTabsTrackingGeneration(environmentId: string): number {
  const key = environmentId.trim()
  return sessionTabsTrackingGenerationByEnvironment.get(key) ?? evictedSessionTabsTrackingGeneration
}
