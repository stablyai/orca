import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree,
  VISIBILITY_INVENTORY_REMOVAL_EPOCH,
  type SessionTabsStreamEvent
} from './state'
import {
  acceptSessionTabsRuntimeId,
  isRetiredSessionTabsPublicationEpoch,
  isHeadlessMergeSessionTabsPublication,
  noteSessionTabsPublicationEpoch,
  sameSessionTabsPublicationLineage
} from './publisher-identity-fences'
import {
  sessionTabsFreshnessKey,
  rememberHostTerminalTabCount,
  trackWebSessionTabsWorktree,
  recordAcceptedWebSessionTabsEnvironment
} from './tracking'
import { clearWebSessionTabsTrackingForWorktree } from './tracking-lifecycle'
import { queueAcceptedWebSessionTerminalSnapshot } from '../web-session-terminal-handle-events'

/** A frame's fate, paired with whether that fate is host evidence for the worktree. */
export type WebSessionTabsSnapshotDecision = {
  readonly apply: boolean
  readonly settlesHostMirror: boolean
}

const WEB_SESSION_TABS_FRAME_APPLIED = {
  apply: true,
  settlesHostMirror: true
} as const satisfies WebSessionTabsSnapshotDecision
export const WEB_SESSION_TABS_FRAME_OUTRANKED = {
  apply: false,
  settlesHostMirror: true
} as const satisfies WebSessionTabsSnapshotDecision
const WEB_SESSION_TABS_FRAME_UNMIRRORED = {
  apply: false,
  settlesHostMirror: false
} as const satisfies WebSessionTabsSnapshotDecision

function isHostMirroredWorktree(worktreeId: string): boolean {
  return worktreeId !== FLOATING_TERMINAL_WORKTREE_ID
}

export function shouldApplyWebSessionTabsSnapshot(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  runtimeId?: string
): boolean {
  return decideWebSessionTabsSnapshot(snapshot, environmentId, runtimeId).apply
}

export function decideWebSessionTabsSnapshot(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  runtimeId?: string
): WebSessionTabsSnapshotDecision {
  if (runtimeId && !acceptSessionTabsRuntimeId(environmentId, runtimeId)) {
    return WEB_SESSION_TABS_FRAME_OUTRANKED
  }
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  if ((snapshot as { removed?: unknown }).removed === true) {
    // Why: removed worktrees can stop publishing, so clean up their tracking now instead of waiting for a replacement snapshot that may never arrive.
    // Retain the removal epoch transition before dropping the live freshness
    // record; delayed sibling frames from the predecessor stay fenced.
    // Inventory omissions use a client-only sentinel epoch; recording that
    // sentinel would retire the host epoch and reject the next live frame.
    if (snapshot.publicationEpoch !== VISIBILITY_INVENTORY_REMOVAL_EPOCH) {
      noteSessionTabsPublicationEpoch(key, snapshot.publicationEpoch)
    }
    clearWebSessionTabsTrackingForWorktree(environmentId, snapshot.worktree)
    queueAcceptedWebSessionTerminalSnapshot(snapshot, environmentId)
    return WEB_SESSION_TABS_FRAME_APPLIED
  }
  if (!isHostMirroredWorktree(snapshot.worktree)) {
    // Why: a remote empty same-id snapshot would delete the user's local floating tabs.
    return WEB_SESSION_TABS_FRAME_UNMIRRORED
  }
  const current = latestSessionTabsSnapshotByWorktree.get(key)
  const currentSharesPublicationLineage = Boolean(
    current &&
    sameSessionTabsPublicationLineage(current.publicationEpoch, snapshot.publicationEpoch)
  )
  const currentIsHeadlessMerge = current
    ? isHeadlessMergeSessionTabsPublication(current.publicationEpoch)
    : false
  const comparePublicationVersions =
    currentSharesPublicationLineage &&
    (currentIsHeadlessMerge || !isHeadlessMergeSessionTabsPublication(snapshot.publicationEpoch))
  if (
    isRetiredSessionTabsPublicationEpoch(key, snapshot.publicationEpoch) &&
    !currentSharesPublicationLineage
  ) {
    return WEB_SESSION_TABS_FRAME_OUTRANKED
  }
  const replayable = replayableSessionTabsSnapshotByWorktree.get(key)
  const isExactCurrentReplay = Boolean(
    current &&
    replayable &&
    current.publicationEpoch === replayable.publicationEpoch &&
    current.snapshotVersion === replayable.snapshotVersion &&
    snapshot.publicationEpoch === replayable.publicationEpoch &&
    snapshot.snapshotVersion === replayable.snapshotVersion
  )
  // Why: reject stale snapshots only within an epoch; host restarts create a new epoch.
  if (
    current &&
    comparePublicationVersions &&
    sameSessionTabsPublicationLineage(current.publicationEpoch, snapshot.publicationEpoch) &&
    snapshot.snapshotVersion <= current.snapshotVersion &&
    !isExactCurrentReplay
  ) {
    return WEB_SESSION_TABS_FRAME_OUTRANKED
  }
  rememberHostTerminalTabCount(environmentId, snapshot)
  replayableSessionTabsSnapshotByWorktree.delete(key)
  noteSessionTabsPublicationEpoch(key, snapshot.publicationEpoch)
  latestSessionTabsSnapshotByWorktree.set(key, {
    publicationEpoch: snapshot.publicationEpoch,
    snapshotVersion: snapshot.snapshotVersion
  })
  trackWebSessionTabsWorktree(environmentId, snapshot.worktree)
  recordAcceptedWebSessionTabsEnvironment(environmentId, snapshot)
  // Why: a mounted mirror that exhausted bounded polling needs fresh host evidence without subscribing to every store write.
  queueAcceptedWebSessionTerminalSnapshot(snapshot, environmentId)
  return WEB_SESSION_TABS_FRAME_APPLIED
}

export function shouldBootstrapInitialWebRuntimeTerminal(args: {
  event: SessionTabsStreamEvent
  activeWorktreeId: string
  requestedInitialTerminal: boolean
  snapshotIsFresh: boolean
  localTerminalCount: number
}): boolean {
  return (
    args.snapshotIsFresh &&
    args.event.type === 'snapshot' &&
    args.event.tabs.length === 0 &&
    args.localTerminalCount === 0 &&
    !args.requestedInitialTerminal &&
    args.activeWorktreeId === args.event.worktree
  )
}

export function shouldRespawnWebRuntimeTerminalAfterWake(args: {
  event: SessionTabsStreamEvent
  activeWorktreeId: string
  requestedRespawnAfterWake: boolean
  snapshotIsFresh: boolean
  localTerminalCount: number
  hasLiveLocalPty: boolean
  skipWakeRespawn?: boolean
}): boolean {
  if (
    !args.snapshotIsFresh ||
    args.requestedRespawnAfterWake ||
    args.skipWakeRespawn === true ||
    args.localTerminalCount === 0 ||
    args.hasLiveLocalPty ||
    (args.event.type !== 'snapshot' && args.event.type !== 'updated')
  ) {
    return false
  }
  if (args.activeWorktreeId !== args.event.worktree) {
    return false
  }
  const hostTerminalTabCount = args.event.tabs.filter((tab) => tab.type === 'terminal').length
  return hostTerminalTabCount === 0
}

export function shouldSyncRuntimeSessionTabs(args: {
  activeWorktreeId?: string | null
  activeWorktreeRuntimeEnvironmentId?: string | null
  workspaceSessionReady: boolean
}): boolean {
  const environmentId = args.activeWorktreeRuntimeEnvironmentId?.trim()
  if (!environmentId || !args.workspaceSessionReady) {
    return false
  }
  return Boolean(args.activeWorktreeId?.trim())
}

export function shouldSyncAllRuntimeSessionTabs(args: {
  activeRuntimeEnvironmentId: string | null | undefined
  workspaceSessionReady: boolean
}): boolean {
  const environmentId = args.activeRuntimeEnvironmentId?.trim()
  return Boolean(environmentId && args.workspaceSessionReady)
}
