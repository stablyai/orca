import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { shouldWritePtyOutputForeground } from '../output/foreground-output-visibility'
import { cancelTerminalScrollIntentBufferRebuildCompletions } from '@/lib/pane-manager/terminal-scroll/terminal-scroll-intent-rebuild'
import {
  HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MS,
  HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MAX
} from './hidden-output-restore-limits'
import { discardTerminalOutput } from '@/lib/pane-manager/terminal-output/pane-terminal-output-queue-registry'

export function initializeHiddenOutputRestoreState(session: ConnectPanePtySession): void {
  session.hiddenOutputRestoreNeeded = false
  session.hiddenOutputRestoreInFlight = null
  session.hiddenOutputRestorePendingChunks = []
  session.hiddenOutputRestorePendingChars = 0
  session.hiddenOutputRestorePendingOverflow = false
  session.hiddenOutputRestoreFreshSnapshotNeeded = false
  session.hiddenOutputRestoreRetryDeferred = false
  session.hiddenOutputRestoreScheduled = false
  session.hiddenOutputRestoreDeferredRetryTimer = null
  session.hiddenOutputRestoreForegroundDeadlineTimer = null
  session.hiddenOutputRestoreDeferredRetryAttempts = 0
  session.hiddenOutputRestoreRemoteOutcomeAttempts = 0
  session.hiddenOutputRestoreLocalGateAttempts = 0
  session.hiddenOutputRestoreLegacyPtyId = null
  // Bounded remote re-arms spent instead of the loss banner (per PTY stream).
  session.hiddenOutputRestoreRemoteAbandonCycles = 0
  // Track latest/disclosed drop episodes because main’s unserved-gap latch re-marks on every reveal.
  session.hiddenOutputRestoreLatestDropEpisode = null
  session.hiddenOutputRestoreUnhideSeq = null
  session.hiddenOutputRestoreDisclosedGap = null
  session.hiddenOutputSnapshotScrollRestore = null
  // Restore bookkeeping belongs to one PTY even when reattach reuses the pane object.
  session.hiddenOutputRestorePtyId = null
  // One recovery re-kick per xterm instance. Generation-aware cooldown and
  // window-cap retries keep a fresh-but-wedged replacement from fossilizing.
  session.certifiedDeadRestoreRecoveryRequested = false
  session.hiddenOutputRestoreGeneration = 0
  // Flood-backpressure suppression (HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS).
  session.hiddenOutputRestoreFloodSuppressedUntil = 0
  // Queued snapshot writes can outlive abandonment; fallback drain must not duplicate the live bytes they cover.
  session.hiddenOutputRestoreReplayingSnapshot = null
  session.hiddenOutputRestoreFloodRepaintTimer = null
  session.cancelHiddenOutputRestoreFloodRepaintPark = null
  // Track restored seq and continuity per PTY to suppress ACK-backlog overlap and detect unmarked pending-cap trim gaps.
  session.restoredSnapshotBaselineSeq = null
  session.restoredSnapshotBaselinePtyId = null
  session.restoredSnapshotExpectedStartSeq = null
  // In-order once-only delivery limits backlog dedup to (pending window start, snapshot baseline].
  session.restoredSnapshotDeliveryWindowStartSeq = null
}

export function bindHiddenOutputRestoreDemand(session: ConnectPanePtySession): void {
  session.markHiddenOutputRestoreNeeded = function (): void {
    const ptyId = session.transport.getPtyId()
    if (!session.canUseHiddenOutputSnapshot(ptyId)) {
      return
    }
    if (session.hiddenOutputRestorePtyId !== null && session.hiddenOutputRestorePtyId !== ptyId) {
      session.clearHiddenOutputRestoreState()
    }
    session.hiddenOutputRestorePtyId = ptyId
    session.hiddenOutputRestoreNeeded = true
    if (shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)) {
      session.requestHiddenOutputRestoreIfNeeded()
    }
  }
}

export function bindHiddenOutputRestoreReset(session: ConnectPanePtySession): void {
  session.scheduleHiddenOutputRestoreDeferredRetry = function (): void {
    if (
      session.disposed ||
      session.hiddenOutputRestoreDeferredRetryTimer !== null ||
      !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
    ) {
      return
    }
    if (
      session.hiddenOutputRestoreDeferredRetryAttempts >= HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MAX
    ) {
      const ptyId = session.hiddenOutputRestorePtyId
      if (ptyId !== null) {
        session.abandonHiddenOutputRestoreAndDrainPendingForeground(ptyId)
      } else {
        session.clearHiddenOutputRestoreState()
        session.writeRestoreUnavailableWarning()
      }
      return
    }
    session.hiddenOutputRestoreDeferredRetryAttempts += 1
    // Why: a null snapshot usually means remote output was still mutating; retry after one quiet tick instead of spinning.
    session.hiddenOutputRestoreDeferredRetryTimer = setTimeout(() => {
      session.hiddenOutputRestoreDeferredRetryTimer = null
      if (session.disposed || !session.hiddenOutputRestoreNeeded) {
        return
      }
      session.hiddenOutputRestoreRetryDeferred = false
      session.requestHiddenOutputRestoreIfNeeded()
    }, HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MS)
  }

  session.clearHiddenOutputRestoreState = function (): void {
    session.cancelSnapshotScrollRestore()
    session.clearPendingLiveChunksDuringRestore()
    // Re-arm budget is per PTY stream, like the rest of this state.
    session.hiddenOutputRestoreRemoteAbandonCycles = 0
    session.hiddenOutputRestoreRemoteOutcomeAttempts = 0
    session.hiddenOutputRestoreLocalGateAttempts = 0
    session.hiddenStartupRendererQueryPending = ''
    session.hiddenRendererStateDirty = false
    session.hiddenOutputRestoreNeeded = false
    session.hiddenOutputRestorePtyId = null
    session.hiddenOutputRestoreReplayingSnapshot = null
    session.hiddenOutputRestoreUnhideSeq = null
    session.hiddenOutputRestoreGeneration += 1
  }

  session.cancelSnapshotScrollRestore = function (): void {
    session.pendingHiddenSnapshotFit?.cancel()
    session.pendingHiddenSnapshotFit = null
    const scrollRestore = session.hiddenOutputSnapshotScrollRestore
    if (!scrollRestore) {
      return
    }
    scrollRestore.valid = false
    session.hiddenOutputSnapshotScrollRestore = null
    if (scrollRestore.started) {
      cancelTerminalScrollIntentBufferRebuildCompletions(session.pane.terminal)
    }
    // Why: invalidation suppresses restoration, but queued bytes still own the bracket until their FIFO sentinels prove parsing finished.
  }
  session.cancelHiddenOutputSnapshotScrollRestore = session.cancelSnapshotScrollRestore
}

export function bindHiddenOutputRestorePtyReset(session: ConnectPanePtySession): void {
  session.resetHiddenOutputRestoreIfPtyChanged = function (): void {
    if (session.hiddenOutputRestorePtyId === null) {
      return
    }
    if (session.transport.getPtyId() !== session.hiddenOutputRestorePtyId) {
      // Why: renderer backlog is tied to the old PTY stream; after reattach it must not delay or replay before the new PTY.
      session.clearHiddenOutputRestoreState()
      session.clearRestoredSnapshotBaseline()
      session.clearPaneMode2031State()
      // Why: flood-backpressure evidence is per PTY stream too.
      session.resetHiddenOutputRestoreFloodSuppression()
      discardTerminalOutput(session.pane.terminal)
    }
  }
}
