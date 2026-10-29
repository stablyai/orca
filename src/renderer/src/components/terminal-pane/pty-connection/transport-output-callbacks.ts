import {
  applyTerminalLaunchResult,
  captureTerminalLaunchContext
} from './terminal-launch-result-policy'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { TerminalAttachmentLaunchResult } from '../../../../../shared/terminal-attachment-launch-result'
import { isPaneOwnerRefusal } from './pane-owner-recovery'
import type { SpawnDeferralReason } from '../../../../../shared/host-spawn-admission'
import { createTerminalStartupTiming } from '../terminal-startup-timing'
import type { PtyReplayDataMeta, PtyTransportRecoveryState } from '../pty-transport-types'
import type { PtyDataMeta } from '../pty-dispatcher'
import type { PtyPaneStartup } from '../pty-connection-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Per-generation transport output callbacks and the hidden-output restore state they reset. */
export function bindCaptureTransportOutputCallbacks(session: ConnectPanePtySession): void {
  const ownerErrors = new Set<string>()
  session.captureTransportOutputCallbacks = (
    onError: (message: string) => void,
    startup: PtyPaneStartup,
    savedStartup: ColdRestoreAgentResumeStartup | PtyPaneStartup = session.paneStartup
  ) => {
    const launchContext = captureTerminalLaunchContext(session, savedStartup)
    // New stream generations drop old replay fit continuations and release live-data waiters.
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
      // Queued stale callbacks cannot mutate a successor reusing the numeric pane slot.
      session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
    session.startupTiming?.finish('replaced')
    session.startupTiming = createTerminalStartupTiming({
      paneKey: session.cacheKey,
      generation,
      getPtyId: () => session.transport.getPtyId(),
      isCurrent,
      isForeground: () => session.deps.isVisibleRef.current,
      onRender: (callback) => session.pane.terminal.onRender(callback)
    })
    return {
      generation,
      launchContext,
      callbacks: {
        onLaunchResult: (result: TerminalAttachmentLaunchResult): void => {
          if (
            isCurrent() &&
            (!session.remotePtyIncarnationId ||
              session.remotePtyIncarnationId === result.incarnationId)
          ) {
            session.remotePtyIncarnationId = result.incarnationId
            session.noteBoundProcessIncarnation(result.incarnationId)
            applyTerminalLaunchResult(session, result, launchContext, 'observer')
          }
        },
        onReattachDetermined: (): void => {
          if (isCurrent()) {
            session.beginReattachLiveDataDeferralIfUnowned(generation)
          }
        },
        onConnect: (): void => {
          if (isCurrent()) {
            for (const message of ownerErrors) {
              session.deps.onPtyErrorClearedRef?.current?.(session.pane.id, message)
            }
            ownerErrors.clear()
            session.startupTiming?.mark('connected')
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
            if (data.length > 0) {
              session.startupTiming?.mark('liveData')
            }
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
            for (const line of message.split('\n')) {
              if (isPaneOwnerRefusal(line)) {
                ownerErrors.add(line)
              }
            }
            session.startupTiming?.finish('error')
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
        onOutputPauseChanged: (
          paused: boolean,
          supported: boolean,
          dropsReported?: boolean
        ): void => {
          if (isCurrent()) {
            session.handleRemoteOutputPauseChanged(paused, supported, dropsReported === true)
          }
        },
        onPausedOutputDropped: (): void => {
          if (isCurrent()) {
            session.handleRemotePausedOutputDropped()
          }
        },
        onSpawnDeferred: (reason: SpawnDeferralReason): void => {
          if (isCurrent()) {
            session.pendingSpawnDeferral = reason
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
