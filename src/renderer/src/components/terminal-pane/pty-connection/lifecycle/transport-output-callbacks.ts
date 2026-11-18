import {
  currentMailWakeStartup,
  isColdRestoreStartup,
  restoreUndispatchedMailWake
} from '../startup/pane-resume-record'
import { useAppStore } from '@/store/index'
import {
  applyTerminalLaunchResult,
  captureTerminalLaunchContext
} from '../startup/terminal-launch-result-policy'
import type { ColdRestoreAgentResumeStartup } from '../startup/fresh-spawn-types'
import type { TerminalAttachmentLaunchResult } from '../../../../../../shared/terminal/pty/lifecycle/terminal-attachment-launch-result'
import { isPaneOwnerRefusal } from '../host-ownership/pane-owner-recovery'
import type { SpawnDeferralReason } from '../../../../../../shared/terminal/pty/admission/spawn-admission-contract'
import { createTerminalStartupTiming } from '../../diagnostics/startup/terminal-startup-timing'
import type {
  PtyReplayDataMeta,
  PtyTransportRecoveryState
} from '../../pty-transport/pty-transport-types'
import type { PtyDataMeta } from '../../pty-transport/delivery/pty-dispatcher'
import type { PtyPaneStartup } from '../startup/pty-pane-startup'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

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
            session.catchUpMode2031()
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
          if (isCurrent() && isColdRestoreStartup(savedStartup)) {
            const record = currentMailWakeStartup(
              savedStartup,
              useAppStore.getState().sleepingAgentSessionsByPaneKey
            ).sleepingRecordEntry?.record
            if (record) {
              restoreUndispatchedMailWake(record)
            }
          }
          if (isCurrent()) {
            session.pendingSpawnDeferral = reason
          }
        }
      }
    }
  }
}
