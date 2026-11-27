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
import { hostSnapshotAffirmsWorktreeContents } from '../../../../../shared/remote-runtime/session-graph/host-session-snapshot-authority'
import { replayWebSessionClosesDueForSnapshot } from '../closing/web-session-close-replay'
import { appPairedTerminalTabCloseIntentStore } from '../closing/paired-terminal-tab-close-intent-store'
import { useAppStore } from '@/store/index'
import { createWebChatReadMarkReceiptBatch } from '@/store/slices/agent-status/structured-sessions/chat-read-mark-web-move'
import { isHostMirroredWorktree } from '../identity/host-mirrored-worktree'
import { isWebSessionTabsWorktreeRemovalFrame } from './session-tabs-inventory-absence'
import { collectCancelledStructuredSessionIds } from '../../native-chat/tab-retirement/structured-agent-session-tab-retirement'
import type { TerminalOrphanRecoveryOptions } from '../../hosted-terminals/recovery/web-session-terminal-orphan-recovery-options'

type MarkBatch = ReturnType<typeof createWebChatReadMarkReceiptBatch>
type SnapshotReceiptOptions = {
  receivedFrame?: number
  runtimeId?: string
  source?: 'stream' | 'bootstrap'
  recoveryOptions?: TerminalOrphanRecoveryOptions
}

function applyChatReadMarkBatch(batch: MarkBatch): void {
  const moved = batch?.move(useAppStore.getState())
  if (moved) {
    useAppStore.setState(moved)
  }
}

export function recordReceivedWebSessionTabsSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number | undefined = undefined,
  runtimeId?: string,
  source: 'stream' | 'bootstrap' = 'stream',
  allowBootstrapMarkMoves = false,
  recoveryOptions?: TerminalOrphanRecoveryOptions
): number {
  const batch =
    source === 'stream' || allowBootstrapMarkMoves ? createWebChatReadMarkReceiptBatch() : undefined
  const frame = recordSnapshotReceipt(
    environmentId,
    snapshot,
    { receivedFrame, runtimeId, source, recoveryOptions },
    batch
  )
  applyChatReadMarkBatch(batch)
  return frame
}

export function recordReceivedWebSessionTabsSnapshots(
  environmentId: string,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  options: Pick<SnapshotReceiptOptions, 'receivedFrame' | 'runtimeId' | 'source'> & {
    onReceipt?: (snapshot: RuntimeMobileSessionTabsResult, frame: number) => void
  }
): number[] {
  const batch = createWebChatReadMarkReceiptBatch()
  const frames = snapshots.map((snapshot) => {
    const frame = recordSnapshotReceipt(environmentId, snapshot, options, batch)
    options.onReceipt?.(snapshot, frame)
    return frame
  })
  applyChatReadMarkBatch(batch)
  return frames
}

function recordSnapshotReceipt(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  { receivedFrame, runtimeId, source = 'stream', recoveryOptions }: SnapshotReceiptOptions,
  batch: MarkBatch
): number {
  const frame = receivedFrame ?? nextReceivedSessionTabsFrame()
  recordBrowserInitializationReceipt(environmentId, snapshot, frame)
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const current = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  // A late bootstrap can verify chat marks without changing receipt or publisher history.
  if (source === 'bootstrap' && current && frame < current.receivedFrame) {
    collectReplyMarkMatches(batch, environmentId, snapshot, frame, runtimeId)
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
    collectReplyMarkMatches(batch, environmentId, snapshot, frame, runtimeId)
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
    return frame
  }
  if (
    !batch ||
    precedesWebSessionTabsRemoval(key, frame) ||
    !hostSnapshotAffirmsWorktreeContents(snapshot) ||
    !isHostMirroredWorktree(snapshot.worktree)
  ) {
    return frame
  }
  batch.collect(
    snapshot.tabs,
    recoveryOptions
      ? (visit) => {
          recoveryOptions.cancelledChatSessionIds = collectCancelledStructuredSessionIds(
            snapshot,
            visit
          )
        }
      : undefined
  )
  return frame
}

export function recordWebSessionTabsReplyForChatReadMarks(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  runtimeId?: string
): void {
  const batch = createWebChatReadMarkReceiptBatch()
  collectReplyMarkMatches(batch, environmentId, snapshot, receivedFrame, runtimeId)
  applyChatReadMarkBatch(batch)
}

function collectReplyMarkMatches(
  batch: MarkBatch,
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  runtimeId?: string
): void {
  if (!batch || !isCurrentSessionTabsRuntimeFrame(environmentId, runtimeId)) {
    return
  }
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  if (
    isWebSessionTabsWorktreeRemovalFrame(snapshot) ||
    !hostSnapshotAffirmsWorktreeContents(snapshot) ||
    isRetiredSessionTabsPublicationEpoch(key, snapshot.publicationEpoch) ||
    precedesWebSessionTabsRemoval(key, receivedFrame) ||
    !isHostMirroredWorktree(snapshot.worktree)
  ) {
    return
  }
  batch.collect(snapshot.tabs)
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
  }
}

/** True for a frame whose place in receipt order was fixed before this worktree was last retracted. */
export function precedesWebSessionTabsRemoval(key: string, receivedFrame: number): boolean {
  return receivedFrame < (sessionTabsRemovalWatermarkByWorktree.get(key) ?? 0)
}
