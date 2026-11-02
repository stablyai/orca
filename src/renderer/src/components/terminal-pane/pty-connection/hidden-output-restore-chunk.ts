import type { PtyDataMeta } from '../pty-dispatcher'

import { HIDDEN_OUTPUT_RESTORE_PENDING_CHARS } from './hidden-output-restore-limits'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { PendingHiddenOutputRestoreChunk } from './pending-hidden-output-restore-chunk'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences
} from '../../../../../shared/terminal-reply-query-scan'
import { isPrimaryDeviceAttributesQuerySequence } from '../../../../../shared/terminal-reply-query-extraction'
import { flushTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { writeXtermParseBarrier } from '@/lib/pane-manager/xterm-parse-barrier'

export function bindHiddenOutputRestoreChunk(session: ConnectPanePtySession): void {
  let coveredQueryScan = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  let coveredQueryPtyId: string | null = null
  let coveredQueryGeneration: number | undefined
  let coveredQueryHighWater = 0
  let coveredQuerySnapshotSeq = 0
  session.answerSnapshotCoveredPrimaryDeviceAttributes = function (
    chunk: PendingHiddenOutputRestoreChunk,
    snapshotSeq: number | undefined
  ): void {
    if (typeof chunk.seq !== 'number' || typeof snapshotSeq !== 'number') {
      return
    }
    const rawLength = chunk.rawLength ?? chunk.data.length
    const startSeq = chunk.seq - rawLength
    const coveredLength = Math.min(rawLength, snapshotSeq - startSeq)
    if (coveredLength <= 0 || (rawLength !== chunk.data.length && coveredLength < rawLength)) {
      return
    }
    const ptyId = session.transport.getPtyId()
    if (
      ptyId !== coveredQueryPtyId ||
      session.transportStreamGeneration !== coveredQueryGeneration ||
      snapshotSeq < coveredQuerySnapshotSeq
    ) {
      coveredQueryScan = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
      coveredQueryPtyId = ptyId
      coveredQueryGeneration = session.transportStreamGeneration
      coveredQueryHighWater = 0
    }
    coveredQuerySnapshotSeq = snapshotSeq
    const coveredEndSeq = startSeq + coveredLength
    if (coveredEndSeq <= coveredQueryHighWater) {
      return
    }
    const mapsToSeq = rawLength === chunk.data.length
    const scanStartSeq = mapsToSeq ? Math.max(startSeq, coveredQueryHighWater) : startSeq
    const scan = scanTerminalReplyQuerySequences(
      chunk.data.slice(scanStartSeq - startSeq, coveredLength),
      scanStartSeq,
      mapsToSeq ? coveredQueryScan : EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )
    coveredQueryHighWater = coveredEndSeq
    coveredQueryScan = mapsToSeq ? scan.state : EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    let primaryQueryCount = 0
    for (const query of scan.queries) {
      if (isPrimaryDeviceAttributesQuerySequence(query.data)) {
        primaryQueryCount += 1
      }
    }
    if (primaryQueryCount > 0) {
      const streamGeneration = session.transportStreamGeneration
      // Drain earlier reports without disturbing the snapshot's incomplete parser tail.
      flushTerminalOutput(session.pane.terminal)
      writeXtermParseBarrier(session.pane.terminal, () => {
        if (
          session.disposed ||
          session.transport.getPtyId() !== ptyId ||
          session.transportStreamGeneration !== streamGeneration
        ) {
          return
        }
        for (let index = 0; index < primaryQueryCount; index += 1) {
          session.terminalCapabilityRepliesDisposable.replyPrimaryDeviceAttributesQuery()
        }
      })
    }
  }

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
    if (meta?.gapEscapeState) {
      pending.gapEscapeState = meta.gapEscapeState
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
      session.answerSnapshotCoveredPrimaryDeviceAttributes(
        { data, seq: meta.seq, rawLength },
        session.restoredSnapshotBaselineSeq
      )
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
    session.answerSnapshotCoveredPrimaryDeviceAttributes(
      { data, seq: meta.seq, rawLength },
      session.restoredSnapshotBaselineSeq
    )
    return {
      action: 'write',
      data: sliced,
      // Why: keep seq metadata consistent with the sliced payload so a later queue drain slices against accurate offsets.
      meta: { ...meta, rawLength: sliced.length }
    }
  }
}
