import { recordBrowserInitializationReceipt } from '../tab-projection/browser-initialization-presentation'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  latestReceivedSessionTabsInventoryFrameByEnvironment,
  latestReceivedSessionTabsSnapshotByWorktree,
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsRemovalWatermarkByWorktree,
  setBoundedSessionTabsReceipt,
  nextReceivedSessionTabsFrame,
  sessionTabsFreshnessKey
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
  receiveWebChatReadMarkFrame,
  retireWebChatReadMarkWorkspace
} from '@/store/slices/agent-status/structured-sessions/chat-read-mark-web-copy'
import { isHostMirroredWorktree } from '../identity/host-mirrored-worktree'
import { isWebSessionTabsWorktreeRemovalFrame } from './session-tabs-inventory-absence'
import { collectCancelledStructuredSessionIds } from '../../native-chat/tab-retirement/structured-agent-session-tab-retirement'
import type { TerminalOrphanRecoveryOptions } from '../../hosted-terminals/recovery/web-session-terminal-orphan-recovery-options'

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
  const isRetraction = isWebSessionTabsWorktreeRemovalFrame(snapshot)
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
    recordReceivedWebSessionTabsRemoval(
      environmentId,
      snapshot.worktree,
      frame,
      publicationEpoch,
      runtimeId,
      censusMember
    )
    return frame
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
    affirmsChats: hostSnapshotAffirmsAgentSessions(snapshot),
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
      for (const snapshot of snapshots) {
        const { worktree } = snapshot
        if (isHostMirroredWorktree(worktree) && !isWebSessionTabsWorktreeRemovalFrame(snapshot)) {
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
  publicationEpoch: string,
  runtimeId?: string,
  censusMember = false
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const latest = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  const recordsLatestReceipt = !latest || latest.receivedFrame <= receivedFrame
  // Retraction is fresh evidence. Record its receipt plus a persistent watermark: later republication overwrites the slot but must not erase the pre-close fence.
  if (recordsLatestReceipt) {
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
    if (recordsLatestReceipt) {
      retireWebSessionTabsReadMarkWorkspace(environmentId, worktreeId, runtimeId, censusMember)
    }
  }
}

export function retireWebSessionTabsReadMarkWorkspace(
  environmentId: string,
  worktreeId: string,
  runtimeId?: string,
  censusMember = false
): void {
  if (!isWebChatReadMarkCopyPending()) {
    return
  }
  const copied = retireWebChatReadMarkWorkspace(
    environmentId,
    worktreeId,
    runtimeId,
    sessionTabsPublicationEpochHistoryByWorktree.get(
      sessionTabsFreshnessKey(environmentId, worktreeId)
    ),
    useAppStore.getState,
    censusMember
  )
  if (copied) {
    useAppStore.setState(copied)
  }
}

/** True for a frame whose place in receipt order was fixed before this worktree was last retracted. */
export function precedesWebSessionTabsRemoval(key: string, receivedFrame: number): boolean {
  return receivedFrame < (sessionTabsRemovalWatermarkByWorktree.get(key) ?? 0)
}
