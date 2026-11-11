import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { createTerminalZeroDimensionsMessage } from '../../../../../shared/terminal/viewport/terminal-zero-dimensions-diagnostic'
import { isWorktreeRemovalFenceError } from '../../../../../shared/worktree/removal-fence-error'
import { safeFit } from '@/lib/pane-manager/pane-fit'
import '@/lib/pane-manager/pane-webgl-renderer'
import {
  getWindowParkVisible,
  subscribeWindowParkVisibility
} from '@/lib/window-activity/window-park-visibility'
import { useAppStore } from '@/store/index'
import { createCodexBackfillErrorDetector } from '../provider-notices/codex-backfill/codex-backfill-error-detector'
import {
  hasWorktreeSleepIntent,
  onWorktreeSleepIntentCleared
} from '@/lib/workspace/sleep/worktree-sleep-intent'
import { recordPtyConnectDiagnostic } from './instrumentation/pty-connect-diagnostics'
import { defersToMainPaneStart } from './spawn/main-pane-start-request'
import { findTerminalTabForPane } from './terminal-tab-id'
import { isDeferredSplitInputHold } from './pane-transport-options'
import { bindBuildColdRestoreAgentResumeStartup } from './startup/cold-restore-resume-startup'
import { bindForegroundOutputRefresh } from './output/foreground-output-refresh'
import { bindRegisterPaneSerializer } from './serialization/pane-serializer-register'
import { bindHandleReattachResult } from './reattach/reattach-result-handler'
import { runDeferredSessionAttach } from './deferred-session-attach'
import { bindSerializeHiddenOutputSnapshot } from './output-restore/hidden-output-snapshot-serialize'
import { bindHiddenStartupDelivery } from './spawn/hidden-startup-delivery'
import { bindHiddenOutputFloodRepaint } from './output-restore/hidden-output-flood-repaint'
import { bindPaneSerializerReadiness } from './serialization/pane-serializer-readiness'
import { bindStartupDraftPaste } from './startup/startup-draft-paste'
import { bindSessionRestoredBannerAdmission } from './notifications/session-restored-banner-admission'
import { bindDeferredColdRestoreAndSnapshot } from './deferred-cold-restore-and-snapshot'
import {
  bindLivePaneMode2031Observation,
  bindPaneMode2031Reset
} from './emulation/pane-mode-2031-state'
import { bindLiveTerminalBuffer } from './output/live-terminal-buffer'
import { bindWritePtyOutputToXterm } from './output/write-pty-output-to-xterm'
import {
  bindHiddenOutputRestoreDemand,
  bindHiddenOutputRestoreReset,
  bindHiddenOutputRestorePtyReset
} from './output-restore/hidden-output-restore-state'
import {
  bindHiddenRendererQueryAdmission,
  bindHiddenStartupRendererQueryWrite
} from './output/hidden-startup-renderer-query-write'
import { bindHiddenOutputRestoreChunk } from './output-restore/hidden-output-restore-chunk'
import { bindSnapshotKittyKeyboardModes } from './emulation/snapshot-kitty-keyboard-modes'
import { bindRendererOrderedSequence } from './output/renderer-ordered-sequence'
import { bindHiddenOutputRestoreDrain } from './output-restore/hidden-output-restore-drain'
import { bindAbandonHiddenOutputRestore } from './output-restore/hidden-output-restore-abandon'
import { bindHiddenOutputRestoreSnapshot } from './output-restore/hidden-output-restore-snapshot'
import { bindHiddenOutputRestoreRequest } from './output-restore/hidden-output-restore-request'
import { bindLiveDataCallback } from './output/live-data-callback'
import {
  bindBeginReattachLiveDataDeferral,
  bindReattachLiveDataDeferral
} from './output/reattach-live-data-deferral'
import { bindParkRevealSnapshotVerdictActions } from './output-restore/park-reveal-snapshot-verdict'
import { bindRemoteProgramRedraw } from './geometry/remote-program-redraw'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Preserve WebGL hook registration before deferred connection setup.

export function installRunDeferredConnect(session: ConnectPanePtySession): void {
  const cwdPromise = session.deps.cwdPromise
  let cwdPromiseSettled = cwdPromise === undefined
  let cwdPromiseWaitStarted = false
  let wakeWaitStarted = false
  let deadlinePassed = false
  let failedFitRetries = 0
  let releaseHideWait: (() => void) | null = null

  session.runDeferredConnect = (): void => {
    if (session.connectStarted || session.disposed) {
      return
    }
    // Slept workspaces retain IDs; wait for wake instead of respawning through reattach, unless queued startup explicitly launches (#10205).
    if (hasWorktreeSleepIntent(session.deps.worktreeId) && !session.paneStartup) {
      session.cancelScheduledConnectFrame()
      if (session.connectFallbackTimer !== null) {
        clearTimeout(session.connectFallbackTimer)
        session.connectFallbackTimer = null
      }
      if (!wakeWaitStarted) {
        wakeWaitStarted = true
        // Why: keys typed into a slept shell must not run in the shell a later wake reattaches.
        if (!isDeferredSplitInputHold(session)) {
          session.transport.abandonPreconnectInput?.()
        }
        recordPtyConnectDiagnostic(
          `pane=${session.pane.id} tab=${session.deps.tabId} -> WAIT FOR WAKE (deliberate sleep)`
        )
        const unsubscribe = onWorktreeSleepIntentCleared(session.deps.worktreeId, () => {
          wakeWaitStarted = false
          const index = session.waitTeardowns.indexOf(unsubscribe)
          if (index !== -1) {
            session.waitTeardowns.splice(index, 1)
          }
          // Activation changes generation and remounts; stale generations must not connect alongside their successor.
          const currentTab = findTerminalTabForPane(
            useAppStore.getState(),
            session.deps.worktreeId,
            session.deps.tabId
          )
          if (!session.disposed && (currentTab?.generation ?? 0) === session.tabGeneration) {
            session.runDeferredConnect()
          }
        })
        // Why: disposal unsubscribes so a torn-down pane never connects on a later wake.
        session.waitTeardowns.push(unsubscribe)
      }
      return
    }
    if (!cwdPromiseSettled) {
      session.cancelScheduledConnectFrame()
      if (!cwdPromiseWaitStarted) {
        cwdPromiseWaitStarted = true
        void cwdPromise?.then(
          (cwd: string) => {
            if (session.disposed) {
              return
            }
            session.deps.cwd = cwd
            session.transportOptions.cwd = cwd
            cwdPromiseSettled = true
            session.runDeferredConnect()
          },
          () => {
            if (session.disposed) {
              return
            }
            cwdPromiseSettled = true
            session.runDeferredConnect()
          }
        )
      }
      return
    }
    const fitCompleted = safeFit(session.pane)
    // Visible local startup commands need their first fitted grid before a TUI can paint.
    const waitForFit =
      Boolean(session.paneStartup?.command || session.paneStartup?.agentLaunch) &&
      session.deps.isVisibleRef.current &&
      getWindowParkVisible() &&
      !session.unservedSshTargetId &&
      session.runtimeEnvironmentId === null
    // Retained-grid fallback must not become slower while frames are available.
    if (waitForFit && !fitCompleted && !deadlinePassed && failedFitRetries < 12) {
      if (releaseHideWait === null) {
        const unsubscribe = subscribeWindowParkVisibility(() => {
          if (!getWindowParkVisible()) {
            session.runDeferredConnect()
          }
        })
        const release = (): void => {
          releaseHideWait = null
          const index = session.waitTeardowns.indexOf(release)
          if (index !== -1) {
            session.waitTeardowns.splice(index, 1)
          }
          unsubscribe()
        }
        releaseHideWait = release
        session.waitTeardowns.push(release)
      }
      session.cancelScheduledConnectFrame()
      failedFitRetries += 1
      session.connectFrame = requestAnimationFrame(session.runDeferredConnect)
      return
    }
    if (defersToMainPaneStart(session, session.runDeferredConnect)) {
      session.cancelScheduledConnectFrame()
      if (session.connectFallbackTimer !== null) {
        clearTimeout(session.connectFallbackTimer)
        session.connectFallbackTimer = null
      }
      return
    }
    session.connectStarted = true
    releaseHideWait?.()
    session.cancelScheduledConnectFrame()
    if (session.connectFallbackTimer !== null) {
      clearTimeout(session.connectFallbackTimer)
      session.connectFallbackTimer = null
    }
    session.cols = session.pane.terminal.cols
    session.rows = session.pane.terminal.rows

    // Report zero fitted geometry only when visible; hidden/unmeasurable tabs legitimately connect before later resize fitting.
    if ((session.cols === 0 || session.rows === 0) && session.deps.isVisibleRef.current) {
      session.deps.onPtyErrorRef?.current?.(
        session.pane.id,
        createTerminalZeroDimensionsMessage(session.cols, session.rows)
      )
    }

    session.reportError = (message: string): void => {
      // Drop async connect errors after disposal so teardown cannot race a user-facing toast.
      if (session.disposed) {
        return
      }
      if (isWorktreeRemovalFenceError(message)) {
        // Removal fences, including overlapping parent/child roots, are expected teardown; never flash their raw spawn/reattach errors.
        return
      }
      session.deps.onPtyErrorRef?.current?.(session.pane.id, message)
    }
    session.codexBackfillErrorDetector =
      session.paneStartup?.launchAgent === 'codex' || session.tab?.launchAgent === 'codex'
        ? createCodexBackfillErrorDetector()
        : null

    // Share serializer/title registration across spawn and reattach, wiring one disposal path for mobile parity (docs/mobile-prefer-renderer-scrollback.md).
    bindRegisterPaneSerializer(session)
    bindPaneSerializerReadiness(session)
    bindStartupDraftPaste(session)
    bindSessionRestoredBannerAdmission(session)
    bindBuildColdRestoreAgentResumeStartup(session)
    bindDeferredColdRestoreAndSnapshot(session)
    session.canUseMainBufferSnapshot = function (ptyId: string | null): ptyId is string {
      return Boolean(ptyId) && !isRemoteRuntimePtyId(ptyId)
    }

    session.canUseHiddenOutputSnapshot = function (ptyId: string | null): ptyId is string {
      if (!ptyId) {
        return false
      }
      if (session.canUseMainBufferSnapshot(ptyId)) {
        return true
      }
      return (
        session.transport.getPtyId() === ptyId &&
        typeof session.transport.serializeBuffer === 'function'
      )
    }

    bindRemoteProgramRedraw(session)
    bindSerializeHiddenOutputSnapshot(session)
    bindHiddenStartupDelivery(session)
    bindHiddenOutputFloodRepaint(session)
    bindForegroundOutputRefresh(session)
    bindLivePaneMode2031Observation(session)
    bindLiveTerminalBuffer(session)
    bindWritePtyOutputToXterm(session)
    bindHiddenOutputRestoreDemand(session)
    bindHiddenRendererQueryAdmission(session)
    bindHiddenStartupRendererQueryWrite(session)
    bindHiddenOutputRestoreChunk(session)
    bindSnapshotKittyKeyboardModes(session)
    bindRendererOrderedSequence(session)
    bindHiddenOutputRestoreDrain(session)
    bindAbandonHiddenOutputRestore(session)
    bindHiddenOutputRestoreReset(session)
    bindPaneMode2031Reset(session)
    bindHiddenOutputRestorePtyReset(session)
    bindHiddenOutputRestoreSnapshot(session)
    bindHiddenOutputRestoreRequest(session)
    bindLiveDataCallback(session)
    bindBeginReattachLiveDataDeferral(session)
    bindReattachLiveDataDeferral(session)
    bindParkRevealSnapshotVerdictActions(session)
    bindHandleReattachResult(session)
    runDeferredSessionAttach(session)
  }

  // Why: Wayland/CI compositors can starve rAF while timers/CDP stay responsive; the terminal must still start its PTY once.
  session.connectFallbackTimer = setTimeout(() => {
    deadlinePassed = true
    session.connectFallbackTimer = null
    session.runDeferredConnect()
  }, 250)
  session.connectFrame = requestAnimationFrame(session.runDeferredConnect)
}
