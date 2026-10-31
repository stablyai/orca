import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { recordTerminalFreezeBreadcrumb } from '../terminal-freeze-breadcrumbs'
import { redactPtyIdForDiagnostics } from '../../../../../shared/pty-delivery-diagnostics'
import { cancelScheduledHiddenOutputRestore } from '../hidden-output-restore-scheduler'
import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'

import {
  HIDDEN_OUTPUT_RESTORE_FOREGROUND_TIMEOUT_MS,
  HIDDEN_OUTPUT_RESTORE_REMOTE_REARM_MAX
} from './hidden-output-restore-limits'
import { shouldWritePtyOutputForeground } from './foreground-output-scan'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { PendingHiddenOutputRestoreChunk } from './pending-hidden-output-restore-chunk'

export function bindHiddenOutputRestoreDrain(session: ConnectPanePtySession): void {
  // 'drained' = painted all queued bytes; 'overflow' = queue blew its cap (stream outran fetch+replay); 'refetch' = offsets unmappable, need a fresher snapshot.
  session.drainPendingLiveChunksAfterSnapshot = function (
    snapshotSeq: number | undefined
  ): 'drained' | 'overflow' | 'refetch' {
    if (session.hiddenOutputRestorePendingOverflow) {
      session.hiddenOutputRestorePendingOverflow = false
      discardPendingLiveChunksSalvagingQueries()
      return 'overflow'
    }
    while (session.hiddenOutputRestorePendingChunks.length > 0) {
      const chunks = session.hiddenOutputRestorePendingChunks
      session.hiddenOutputRestorePendingChunks = []
      session.hiddenOutputRestorePendingChars = 0
      for (const [index, chunk] of chunks.entries()) {
        const data = session.getChunkDataAfterSnapshot(chunk, snapshotSeq)
        if (data === null) {
          // Why: renderer-only OSC stripping makes raw seq offsets unmappable onto cleaned text; refetch instead of risking duplicate output.
          for (const discarded of chunks.slice(index)) {
            session.salvageRendererQueriesFromDiscardedRestoreData(discarded.data)
          }
          discardPendingLiveChunksSalvagingQueries()
          return 'refetch'
        }
        session.answerSnapshotCoveredPrimaryDeviceAttributes(chunk, snapshotSeq)
        // Why: advance the continuity point so reconciliation neither re-drops drained chunks as duplicates nor misreads the next live chunk as a gap.
        if (typeof chunk.seq === 'number' && session.restoredSnapshotExpectedStartSeq !== null) {
          session.restoredSnapshotExpectedStartSeq = Math.max(
            session.restoredSnapshotExpectedStartSeq,
            chunk.seq
          )
        }
        if (data) {
          session.writePtyOutputToXterm(data, true)
          session.recordRendererOrderedSeq(chunk)
        }
      }
      if (session.hiddenOutputRestorePendingOverflow) {
        session.hiddenOutputRestorePendingOverflow = false
        discardPendingLiveChunksSalvagingQueries()
        return 'overflow'
      }
    }
    return 'drained'
  }

  function discardPendingLiveChunksSalvagingQueries(): void {
    const discarded = session.hiddenOutputRestorePendingChunks
    session.hiddenOutputRestorePendingChunks = []
    session.hiddenOutputRestorePendingChars = 0
    for (const chunk of discarded) {
      session.salvageRendererQueriesFromDiscardedRestoreData(chunk.data)
    }
  }

  session.clearPendingLiveChunksDuringRestore = function (): void {
    session.hiddenOutputRestorePendingChunks = []
    session.hiddenOutputRestorePendingChars = 0
    session.hiddenOutputRestorePendingOverflow = false
    session.hiddenOutputRestoreFreshSnapshotNeeded = false
    session.hiddenOutputRestoreRetryDeferred = false
    session.hiddenOutputRestoreScheduled = false
    cancelScheduledHiddenOutputRestore(session.pane.terminal)
    session.clearHiddenOutputRestoreDeferredRetryTimer()
    session.clearHiddenOutputRestoreForegroundDeadlineTimer()
    session.hiddenOutputRestoreDeferredRetryAttempts = 0
  }

  session.clearHiddenOutputRestoreDeferredRetryTimer = function (): void {
    if (session.hiddenOutputRestoreDeferredRetryTimer === null) {
      return
    }
    clearTimeout(session.hiddenOutputRestoreDeferredRetryTimer)
    session.hiddenOutputRestoreDeferredRetryTimer = null
  }
  session.cleanupHiddenOutputRestoreDeferredRetry =
    session.clearHiddenOutputRestoreDeferredRetryTimer

  session.clearHiddenOutputRestoreForegroundDeadlineTimer = function (): void {
    if (session.hiddenOutputRestoreForegroundDeadlineTimer === null) {
      return
    }
    clearTimeout(session.hiddenOutputRestoreForegroundDeadlineTimer)
    session.hiddenOutputRestoreForegroundDeadlineTimer = null
  }
  session.cleanupHiddenOutputRestoreForegroundDeadline =
    session.clearHiddenOutputRestoreForegroundDeadlineTimer

  session.armHiddenOutputRestoreForegroundDeadline = function (): void {
    if (
      session.disposed ||
      session.hiddenOutputRestoreForegroundDeadlineTimer !== null ||
      !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current) ||
      (isRemoteRuntimePtyId(session.hiddenOutputRestorePtyId) &&
        session.hiddenOutputRestoreLegacyPtyId !== session.hiddenOutputRestorePtyId &&
        typeof session.transport.serializeBufferOutcome === 'function') ||
      (session.hiddenOutputRestorePendingChunks.length === 0 &&
        !session.hiddenOutputRestorePendingOverflow)
    ) {
      return
    }
    const ptyId = session.hiddenOutputRestorePtyId
    if (ptyId === null || session.transport.getPtyId() !== ptyId) {
      return
    }
    const deadlineGeneration = session.hiddenOutputRestoreGeneration
    // Why: only foreground output blocked behind recovery gets a deadline; hidden-time restore work has no user impact.
    session.hiddenOutputRestoreForegroundDeadlineTimer = setTimeout(() => {
      session.hiddenOutputRestoreForegroundDeadlineTimer = null
      if (
        session.disposed ||
        session.hiddenOutputRestoreGeneration !== deadlineGeneration ||
        session.hiddenOutputRestorePtyId !== ptyId ||
        !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
      ) {
        return
      }
      // A painted snapshot awaiting fit proves recovery answered, regardless of live queue size.
      const replayed = session.hiddenOutputRestoreReplayingSnapshot
      let preserveReplayState = false
      if (replayed) {
        session.setRestoredSnapshotBaseline(ptyId, replayed, replayed.paintsContent === true)
        const needsRepaint =
          session.hiddenOutputRestorePendingOverflow ||
          session.hiddenOutputRestoreFreshSnapshotNeeded ||
          (session.hiddenOutputRestoreUnhideSeq !== null &&
            replayed.seq < session.hiddenOutputRestoreUnhideSeq) ||
          session.hiddenOutputRestorePendingChunks.some(
            (chunk: PendingHiddenOutputRestoreChunk) =>
              session.getChunkDataAfterSnapshot(chunk, replayed.seq) === null
          )
        preserveReplayState = !needsRepaint
        if (needsRepaint) {
          session.noteHiddenOutputRestoreFloodBackpressure()
        }
      }
      session.abandonHiddenOutputRestoreAndDrainPendingForeground(ptyId, {
        quiet: replayed !== null,
        preserveReplayState
      })
    }, HIDDEN_OUTPUT_RESTORE_FOREGROUND_TIMEOUT_MS)
  }

  // Arm one quiet host/main repaint before resetting the PTY ID, matching other flood-abandon paths.
  session.rearmRemoteHiddenOutputRestoreInsteadOfWarning = function (
    ptyId: string,
    reason: string
  ): boolean {
    if (!isRemoteExecutionHostPtyId(ptyId)) {
      return false
    }
    if (session.hiddenOutputRestoreRemoteAbandonCycles >= HIDDEN_OUTPUT_RESTORE_REMOTE_REARM_MAX) {
      // Reset budgets after disclosed stalls so one outage cannot make every later unverifiable snapshot immediately banner.
      session.hiddenOutputRestoreRemoteAbandonCycles = 0
      return false
    }
    session.hiddenOutputRestoreRemoteAbandonCycles += 1
    recordTerminalFreezeBreadcrumb('restore-abandon-rearm', {
      id: redactPtyIdForDiagnostics(ptyId),
      reason,
      cycle: session.hiddenOutputRestoreRemoteAbandonCycles
    })
    session.noteHiddenOutputRestoreFloodBackpressure()
    session.writeAbandonedRestoreGap()
    return true
  }
}
