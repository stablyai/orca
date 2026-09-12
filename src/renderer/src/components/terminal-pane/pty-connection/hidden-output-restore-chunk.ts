import type { PtyDataMeta } from '../pty-dispatcher'

import { HIDDEN_OUTPUT_RESTORE_PENDING_CHARS } from './hidden-output-restore-limits'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { PendingHiddenOutputRestoreChunk } from './pending-hidden-output-restore-chunk'

export function bindHiddenOutputRestoreChunk(session: ConnectPanePtySession): void {
  session.queueLiveChunkDuringRestore = function (data: string, meta?: PtyDataMeta): void {
    if (!data) {
      return
    }
    const ptyId = session.transport.getPtyId()
    if (!session.canUseHiddenOutputSnapshot(ptyId)) {
      return
    }
    if (session.hiddenOutputRestorePtyId !== null && session.hiddenOutputRestorePtyId !== ptyId) {
      session.clearHiddenOutputRestoreState()
    }
    session.hiddenOutputRestorePtyId = ptyId
    session.hiddenOutputRestoreNeeded = true
    if (session.hiddenOutputRestorePendingOverflow) {
      // Why: the overflow latch discards everything queued at the next drain, so queueing more only grows the discard; salvage queries, drop content.
      session.salvageRendererQueriesFromDiscardedRestoreData(data)
      session.armHiddenOutputRestoreForegroundDeadline()
      return
    }
    if (
      session.hiddenOutputRestorePendingChars + data.length >
      HIDDEN_OUTPUT_RESTORE_PENDING_CHARS
    ) {
      const discardedChunks = session.hiddenOutputRestorePendingChunks
      session.hiddenOutputRestorePendingChunks = []
      session.hiddenOutputRestorePendingChars = 0
      session.hiddenOutputRestorePendingOverflow = true
      for (const chunk of discardedChunks) {
        session.salvageRendererQueriesFromDiscardedRestoreData(chunk.data)
      }
      session.salvageRendererQueriesFromDiscardedRestoreData(data)
      session.armHiddenOutputRestoreForegroundDeadline()
      return
    }
    const pending: PendingHiddenOutputRestoreChunk = { data }
    if (typeof meta?.seq === 'number') {
      pending.seq = meta.seq
    }
    if (typeof meta?.rawLength === 'number') {
      pending.rawLength = meta.rawLength
    }
    session.hiddenOutputRestorePendingChunks.push(pending)
    session.hiddenOutputRestorePendingChars += data.length
    session.armHiddenOutputRestoreForegroundDeadline()
  }

  session.getChunkDataAfterSnapshot = function (
    chunk: PendingHiddenOutputRestoreChunk,
    snapshotSeq: number | undefined
  ): string | null {
    if (typeof snapshotSeq !== 'number' || typeof chunk.seq !== 'number') {
      return chunk.data
    }
    const rawLength = chunk.rawLength ?? chunk.data.length
    const startSeq = chunk.seq - rawLength
    if (snapshotSeq >= chunk.seq) {
      return ''
    }
    if (snapshotSeq <= startSeq) {
      return chunk.data
    }
    const offset = snapshotSeq - startSeq
    if (rawLength !== chunk.data.length) {
      return null
    }
    return chunk.data.slice(offset)
  }

  type RestoredSnapshotReconciliation =
    | { action: 'write'; data: string; meta: PtyDataMeta | undefined }
    | { action: 'drop-duplicate' }
    | { action: 'force-fresh-restore' }

  // Why: same slicing as session.getChunkDataAfterSnapshot but for post-restore live chunks, which main's ACK backlog can still deliver at/before the snapshot seq (and can trim seq ranges silently).
  session.reconcileChunkAgainstRestoredSnapshot = function (
    data: string,
    meta: PtyDataMeta | undefined
  ): RestoredSnapshotReconciliation {
    if (session.restoredSnapshotBaselineSeq === null) {
      return { action: 'write', data, meta }
    }
    if (session.transport.getPtyId() !== session.restoredSnapshotBaselinePtyId) {
      session.clearRestoredSnapshotBaseline()
      return { action: 'write', data, meta }
    }
    if (typeof meta?.seq !== 'number') {
      // Why: seq-less chunks (no runtime metering) can't be reconciled; pass them through like session.getChunkDataAfterSnapshot.
      return { action: 'write', data, meta }
    }
    if (
      session.restoredSnapshotDeliveryWindowStartSeq !== null &&
      meta.seq <= session.restoredSnapshotDeliveryWindowStartSeq
    ) {
      // Why: all still-deliverable bytes started after this seq and delivery is in-order, so this can't be a backlog dup — it's a new seq domain; retire the baseline and write.
      session.clearRestoredSnapshotBaseline()
      return { action: 'write', data, meta }
    }
    const rawLength = meta.rawLength ?? data.length
    const startSeq = meta.seq - rawLength
    const expectedStartSeq = session.restoredSnapshotExpectedStartSeq
    session.restoredSnapshotExpectedStartSeq = Math.max(expectedStartSeq ?? meta.seq, meta.seq)
    if (expectedStartSeq !== null && startSeq > expectedStartSeq) {
      // Why: the chunk starts past the continuity point — bytes between were dropped (pending-cap trim); only a fresh snapshot heals the gap.
      return { action: 'force-fresh-restore' }
    }
    if (meta.seq <= session.restoredSnapshotBaselineSeq) {
      return { action: 'drop-duplicate' }
    }
    if (startSeq >= session.restoredSnapshotBaselineSeq) {
      return { action: 'write', data, meta }
    }
    if (rawLength !== data.length) {
      // Why: renderer-only OSC stripping makes raw seq offsets unmappable onto cleaned text; refetch instead of risking duplicate output.
      return { action: 'force-fresh-restore' }
    }
    const sliced = data.slice(session.restoredSnapshotBaselineSeq - startSeq)
    return {
      action: 'write',
      data: sliced,
      // Why: keep seq metadata consistent with the sliced payload so a later queue drain slices against accurate offsets.
      meta: { ...meta, rawLength: sliced.length }
    }
  }
}
