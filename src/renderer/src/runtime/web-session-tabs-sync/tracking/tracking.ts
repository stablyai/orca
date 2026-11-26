import { recordBrowserInitializationReceipt } from '../tab-projection/browser-initialization-presentation'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
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
} from '../state'
import {
  acceptSessionTabsRuntimeId,
  isCurrentSessionTabsRuntimeFrame,
  isRetiredSessionTabsPublicationEpoch,
  noteSessionTabsPublicationEpoch,
  recordReceivedWebSessionTabsEnvironmentFrame
} from './publisher-identity-fences'
import {
  hostSnapshotAffirmsAgentSessions,
  hostSnapshotAffirmsWorktreeContents
} from '../../../../../shared/remote-runtime/session-graph/host-session-snapshot-authority'
import { replayWebSessionClosesDueForSnapshot } from '../closing/web-session-close-replay'
import { appPairedTerminalTabCloseIntentStore } from '../closing/paired-terminal-tab-close-intent-store'
import { useAppStore } from '@/store/index'
import {
  isWebChatReadMarkCopyPending,
  receiveWebChatReadMarkCandidates,
  receiveWebChatReadMarkCensus,
  receiveWebChatReadMarkFrame
} from '@/store/slices/agent-status/structured-sessions/chat-read-mark-web-copy'
import { isHostMirroredWorktree } from '../identity/host-mirrored-worktree'
import { collectCancelledStructuredSessionIds } from '../../native-chat/tab-retirement/structured-agent-session-tab-retirement'
import type { TerminalOrphanRecoveryOptions } from '../../hosted-terminals/recovery/web-session-terminal-orphan-recovery-options'

export function isSessionTabsListAllResult(value: unknown): value is SessionTabsListAllResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as { snapshots?: unknown }).snapshots)
  )
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
  source: 'stream' | 'bootstrap' = 'stream',
  censusMember = false,
  recoveryOptions?: TerminalOrphanRecoveryOptions
): number {
  const frame = receivedFrame ?? nextReceivedSessionTabsFrame()
  recordBrowserInitializationReceipt(environmentId, snapshot, frame)
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const current = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  // A late bootstrap can supply chat candidates without changing receipt or publisher history.
  if (source === 'bootstrap' && current && frame < current.receivedFrame) {
    if (censusMember) {
      recordWebSessionTabsReplyCandidates(environmentId, snapshot, frame, runtimeId)
    }
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
  const recordsLatestReceipt =
    source === 'stream' ||
    !current ||
    current.publicationEpoch !== publicationEpoch ||
    snapshot.snapshotVersion > current.snapshotVersion ||
    (snapshot.snapshotVersion === current.snapshotVersion && current.receivedFrame <= frame)
  if (!recordsLatestReceipt) {
    if (censusMember) {
      recordWebSessionTabsReplyCandidates(environmentId, snapshot, frame, runtimeId)
    }
    return frame
  }
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
  if (
    !isWebChatReadMarkCopyPending() ||
    (source !== 'stream' && !censusMember) ||
    precedesWebSessionTabsRemoval(key, frame) ||
    !isHostMirroredWorktree(snapshot.worktree)
  ) {
    return frame
  }
  const copied = receiveWebChatReadMarkFrame(useAppStore.getState(), {
    environmentId,
    worktreeId: snapshot.worktree,
    runtimeId,
    trackingRecord: sessionTabsPublicationEpochHistoryByWorktree.get(key),
    affirmsChats: !isRetraction && hostSnapshotAffirmsAgentSessions(snapshot),
    tabs: snapshot.tabs,
    censusMember,
    // Share the stream's pre-recovery tab walk with cancelled-chat detection.
    scanChatSessions: recoveryOptions
      ? (visit) => {
          recoveryOptions.cancelledChatSessionIds = collectCancelledStructuredSessionIds(
            snapshot,
            visit
          )
        }
      : undefined
  })
  if (copied) {
    useAppStore.setState(copied)
  }
  return frame
}

export function recordWebSessionTabsReplyCandidates(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  runtimeId?: string
): void {
  if (
    !isWebChatReadMarkCopyPending() ||
    !isCurrentSessionTabsRuntimeFrame(environmentId, runtimeId)
  ) {
    return
  }
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  if (
    isRetiredSessionTabsPublicationEpoch(key, snapshot.publicationEpoch) ||
    precedesWebSessionTabsRemoval(key, receivedFrame) ||
    !isHostMirroredWorktree(snapshot.worktree)
  ) {
    return
  }
  receiveWebChatReadMarkCandidates(useAppStore.getState(), snapshot.tabs)
}

export function recordWebSessionTabsCensusForChatReadMarks(
  environmentId: string,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  runtimeId: string | undefined,
  requestReceivedFrame?: number
): void {
  if (
    !isWebChatReadMarkCopyPending() ||
    !isCurrentSessionTabsRuntimeFrame(environmentId, runtimeId) ||
    (requestReceivedFrame !== undefined &&
      (latestReceivedSessionTabsInventoryFrameByEnvironment.get(environmentId) ?? 0) >
        requestReceivedFrame)
  ) {
    return
  }
  const copied = receiveWebChatReadMarkCensus(
    useAppStore.getState(),
    environmentId,
    runtimeId,
    (function* () {
      for (const { worktree } of snapshots) {
        if (isHostMirroredWorktree(worktree)) {
          yield [
            worktree,
            sessionTabsPublicationEpochHistoryByWorktree.get(
              sessionTabsFreshnessKey(environmentId, worktree)
            )
          ] as const
        }
      }
    })()
  )
  if (copied) {
    useAppStore.setState(copied)
  }
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
  return (
    isCurrentSessionTabsRuntimeFrame(environmentId, runtimeId) &&
    canApplyWebSessionTabsWorktreeFrame(environmentId, snapshot, receivedFrame, 'recovery')
  )
}

/** Admit the verified replacement runtime before its feed arrives, without advancing the worktree cursor. */
export function admitWebSessionTabsChatRead(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  runtimeId: string | undefined,
  verifiedRuntimeId: string | undefined
): boolean {
  return (
    canApplyWebSessionTabsWorktreeFrame(environmentId, snapshot, receivedFrame, 'read') &&
    (isCurrentSessionTabsRuntimeFrame(environmentId, runtimeId) ||
      (runtimeId !== undefined &&
        runtimeId === verifiedRuntimeId &&
        acceptSessionTabsRuntimeId(environmentId, runtimeId, receivedFrame)))
  )
}

function canApplyWebSessionTabsWorktreeFrame(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  source: 'recovery' | 'read'
): boolean {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  if (isRetiredSessionTabsPublicationEpoch(key, snapshot.publicationEpoch)) {
    return false
  }
  if (precedesWebSessionTabsRemoval(key, receivedFrame)) {
    return false
  }

  const latest = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  if (!latest) {
    return source === 'read'
  }
  if (latest.receivedFrame === receivedFrame) {
    return true
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
