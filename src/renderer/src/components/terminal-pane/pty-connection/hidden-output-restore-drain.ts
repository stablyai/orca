import { recordTerminalFreezeBreadcrumb } from '../terminal-freeze-breadcrumbs'
import { redactPtyIdForDiagnostics } from '../../../../../shared/pty-delivery-diagnostics'
import { RESET_AFTER_BYTE_GAP } from '../../../../../shared/terminal-mode-reset-profiles'
import { cancelScheduledHiddenOutputRestore } from '../hidden-output-restore-scheduler'
import { isRemoteExecutionHostPtyId } from '../remote-execution-host-pty'

import {
  HIDDEN_OUTPUT_RESTORE_FOREGROUND_TIMEOUT_MS,
  HIDDEN_OUTPUT_RESTORE_REMOTE_REARM_MAX
} from './hidden-output-restore-limits'
import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

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
      session.abandonHiddenOutputRestoreAndDrainPendingForeground(ptyId)
    }, HIDDEN_OUTPUT_RESTORE_FOREGROUND_TIMEOUT_MS)
  }

  // Trades the loss banner for one bounded post-suppression repaint from whatever
  // answers for this PTY — the paired runtime's own buffer, or main's model of the
  // direct-SSH stream. Ordered before the state reset so the repaint timer arms
  // against the live ptyId (mirrors the flood-abandon call sites).
  session.rearmRemoteHiddenOutputRestoreInsteadOfWarning = function (
    ptyId: string,
    reason: string
  ): boolean {
    if (!isRemoteExecutionHostPtyId(ptyId)) {
      return false
    }
    if (session.hiddenOutputRestoreRemoteAbandonCycles >= HIDDEN_OUTPUT_RESTORE_REMOTE_REARM_MAX) {
      // Why the reset: the budget bounds ONE stall, and returning false ends that
      // stall with the loss banner. Without this, the counter only ever clears on a
      // successful snapshot or a PTY change, so a single ~10s outage leaves a
      // long-lived SSH pane at zero tolerance — every later hidden episode banners
      // on the first null even though that null is still only `unverifiable`.
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
    session.writePtyOutputToXterm(RESET_AFTER_BYTE_GAP, true)
    return true
  }
}
