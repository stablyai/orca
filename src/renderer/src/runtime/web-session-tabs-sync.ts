/** Public boundary for the web runtime session-tab mirror. */
export {
  applyFreshWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshots,
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  applyWebSessionTabsSnapshotOperations,
  decideWebSessionTabsSnapshotOperations
} from './web-session-tabs-sync/snapshot-api'
export type {
  DecidedWebSessionTabsSnapshotOperation,
  WebSessionTabsSnapshotOperation
} from './web-session-tabs-sync/snapshot-api'

export {
  acceptReplayedWebSessionTabsSnapshot,
  clearWebSessionTabsTrackingForEnvironment,
  getLastKnownHostTerminalTabCount,
  getLatestWebSessionTabsPublicationEpoch,
  getWebSessionTabsTrackingGeneration,
  resetWebSessionTabsSnapshotFreshnessForTests,
  _getWebSessionTabsRecoveryTrackingCountsForTest,
  _getWebSessionTabsTrackingCountsForTest
} from './web-session-tabs-sync/tracking-lifecycle'
export { resolveHostSessionTabIdForWebSessionTab } from './web-session-tabs-sync/tracking-mappings'
export {
  decideWebSessionTabsSnapshot,
  shouldApplyWebSessionTabsSnapshot,
  shouldBootstrapInitialWebRuntimeTerminal,
  shouldRespawnWebRuntimeTerminalAfterWake,
  shouldSyncAllRuntimeSessionTabs,
  shouldSyncRuntimeSessionTabs,
  WEB_SESSION_TABS_FRAME_OUTRANKED
} from './web-session-tabs-sync/tracking-decisions'
export type { WebSessionTabsSnapshotDecision } from './web-session-tabs-sync/tracking-decisions'

export { applyWebSessionTabsStorePatch } from './web-session-tabs-sync/store-patch'
export type {
  HostSessionMirrorPatchFrame,
  HostSessionMirrorPatchVerdict,
  HostSessionMirrorSettle
} from './web-session-tabs-sync/mirror-settle'
export {
  hostSessionMirrorSettleForPatchlessFrame,
  createHostSessionMirrorSettle
} from './web-session-tabs-sync/mirror-settle'

export { WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS } from './web-session-tabs-sync/state'
export type {
  WebSessionTabsSnapshotApplyOptions,
  WebSessionTabsSyncState,
  SessionTabsStreamEvent
} from './web-session-tabs-sync/state'

export { useWebSessionTabsSync } from './web-session-tabs-sync/use-web-session-tabs-sync'
