import type { PtyReplayDataMeta } from '../pty-transport'
import type { PtyTransportRecoveryState } from '../pty-transport-types'
import type { PtyDataMeta } from '../pty-dispatcher'
import type { PtyPaneStartup } from '../pty-connection-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Per-generation transport output callbacks and the hidden-output restore state they reset. */
export function bindCaptureTransportOutputCallbacks(session: ConnectPanePtySession): void {
  session.captureTransportOutputCallbacks = (
    onError: (message: string) => void,
    startup: PtyPaneStartup
  ) => {
    // Why: a new stream generation cannot inherit an old replay's pending
    // destination-grid fit or keep its live-data waiter open.
    session.pendingHiddenSnapshotFit?.cancel()
    session.pendingHiddenSnapshotFit = null
    session.pendingReattachFit?.cancel()
    session.pendingReattachFit = null
    const generation = (session.transportStreamGeneration += 1)
    const processExitState = session.createProcessExitState(startup)
    session.currentProcessExitState = processExitState
    const isCurrent = (): boolean =>
      !session.disposed &&
      generation === session.transportStreamGeneration &&
      // A successor may occupy the same numeric pane slot before the old
      // stream's queued callback runs; only the registered transport may
      // mutate pane-scoped error/recovery state.
      session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
    return {
      generation,
      callbacks: {
        onReattachDetermined: (): void => {
          if (isCurrent()) {
            session.beginReattachLiveDataDeferralIfUnowned(generation)
          }
        },
        onConnect: (): void => {
          if (isCurrent()) {
            session.reportRemoteRendererSerializerReady()
            // Re-derive the pause bit after a rebind; visibility can change while no PTY is bound.
            session.syncHiddenRendererPtyDelivery()
          }
        },
        onStreamRecovered: (): void => {
          if (isCurrent()) {
            session.markHiddenOutputRestoreNeeded()
          }
        },
        onData: (data: string, meta?: PtyDataMeta): void => {
          if (isCurrent()) {
            processExitState.detector.observe(data)
            session.dataCallback(data, meta, generation)
          }
        },
        onReplayData: (data: string, meta?: PtyReplayDataMeta): void => {
          if (isCurrent()) {
            session.replayDataCallback(data, meta, generation)
          }
        },
        onError: (message: string): void => {
          if (isCurrent()) {
            onError(message)
          }
        },
        onErrorCleared: (message: string): void => {
          if (isCurrent()) {
            session.deps.onPtyErrorClearedRef?.current?.(session.pane.id, message)
          }
        },
        onWriteUnavailable: (): void => {
          if (isCurrent()) {
            session.requestRecoveryForUndeliverableInput(true)
          }
        },
        onRecoveryStateChange: (state: PtyTransportRecoveryState): void => {
          if (isCurrent()) {
            // Why: cached pixels remain visible while detached; expose transport truth for diagnostics and recovery UI.
            session.pane.container.dataset.ptyRecoveryState = state.phase
            session.deps.onPtyRecoveryStateRef?.current?.(session.pane.id, state)
          }
        },
        onOutputPauseChanged: (paused: boolean, supported: boolean): void => {
          if (isCurrent()) {
            session.handleRemoteOutputPauseChanged(paused, supported)
          }
        }
      }
    }
  }

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
  session.hiddenOutputSnapshotScrollRestore = null
  // Why: hidden recovery state belongs to one PTY stream. Reattach/restart
  // can reuse the pane object for a different session before visibility.
  session.hiddenOutputRestorePtyId = null
  // One recovery re-kick per xterm instance. Generation-aware cooldown and
  // window-cap retries keep a fresh-but-wedged replacement from fossilizing.
  session.certifiedDeadRestoreRecoveryRequested = false
  session.hiddenOutputRestoreGeneration = 0
  // Flood-backpressure suppression (HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS).
  session.hiddenOutputRestoreFloodSuppressedUntil = 0
  // Why: queued replay writes still paint after deadline abandonment; the
  // fallback drain must not write snapshot-covered live bytes a second time.
  session.hiddenOutputRestoreReplayingSnapshot = null
  session.hiddenOutputRestoreFloodRepaintTimer = null
  session.cancelHiddenOutputRestoreFloodRepaintPark = null
  // Why: after a snapshot restore, main can still drain ACK-backlog chunks
  // whose bytes the snapshot already covers — writing them unguarded
  // duplicates visible output. Track the restored baseline seq (per PTY)
  // and the expected next chunk start so session.dataCallback can drop/slice
  // overlaps and detect seq gaps from main-side pending-cap trims whose
  // one-shot marker was already consumed.
  session.restoredSnapshotBaselineSeq = null
  session.restoredSnapshotBaselinePtyId = null
  session.restoredSnapshotExpectedStartSeq = null
  // Why: main samples its pending renderer-delivery queue with the snapshot.
  // Chunks at or below this seq can never be backlog duplicates (delivery is
  // once-and-in-order), so the dedupe window is (windowStart, baseline].
  session.restoredSnapshotDeliveryWindowStartSeq = null
}
