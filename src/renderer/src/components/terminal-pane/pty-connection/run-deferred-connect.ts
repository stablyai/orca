import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { createTerminalZeroDimensionsMessage } from '../../../../../shared/terminal-zero-dimensions-diagnostic'
import { isWorktreeRemovalFenceError } from '../../../../../shared/worktree/removal-fence-error'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'
import { useAppStore } from '@/store'
import { createCodexBackfillErrorDetector } from '../codex-backfill-error-detector'
import { hasWorktreeSleepIntent, onWorktreeSleepIntentCleared } from '@/lib/worktree-sleep-intent'

import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import { defersToMainPaneStart } from './main-pane-start-request'
import { findTerminalTabForPane } from './terminal-tab-id'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindBuildColdRestoreAgentResumeStartup } from './cold-restore-resume-startup'

import { bindForegroundOutputRefresh } from './foreground-output-refresh'
import { bindRegisterPaneSerializer } from './pane-serializer-register'
import { bindHandleReattachResult } from './reattach-result-handler'
import { runDeferredSessionAttach } from './deferred-session-attach'

import { bindSerializeHiddenOutputSnapshot } from './hidden-output-snapshot-serialize'
import { bindSettlePaneSerializer } from './pane-serializer-settle'

import { bindDeferredColdRestoreAndSnapshot } from './deferred-cold-restore-and-snapshot'
import { bindHiddenOutputSeqAndSkip } from './hidden-output-seq-and-skip'
import { bindHiddenRestoreState } from './hidden-restore-state'
import { bindParkRevealSnapshotVerdictActions } from './park-reveal-snapshot-verdict'
import { bindRemoteProgramRedraw } from './remote-program-redraw'

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
    // Why: a deliberately slept workspace keeps its panes mounted, so connecting
    // would reattach the retained session id and respawn the shell (#10205).
    // Wait for the wake instead; a queued startup is an explicit launch.
    if (hasWorktreeSleepIntent(session.deps.worktreeId) && !session.paneStartup) {
      session.cancelScheduledConnectFrame()
      if (session.connectFallbackTimer !== null) {
        clearTimeout(session.connectFallbackTimer)
        session.connectFallbackTimer = null
      }
      if (!wakeWaitStarted) {
        wakeWaitStarted = true
        recordPtyConnectDiagnostic(
          `pane=${session.pane.id} tab=${session.deps.tabId} -> WAIT FOR WAKE (deliberate sleep)`
        )
        const unsubscribe = onWorktreeSleepIntentCleared(session.deps.worktreeId, () => {
          wakeWaitStarted = false
          const index = session.waitTeardowns.indexOf(unsubscribe)
          if (index !== -1) {
            session.waitTeardowns.splice(index, 1)
          }
          // Why: an activation wake bumps the tab generation in the same tick and the
          // remounted pane connects on its own; a stale generation must not connect too.
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

    // Why: if fitAddon resolved to 0×0, the container likely has no layout
    // dimensions (display:none, unmounted, or zero-size parent). Surface a
    // diagnostic so the user sees something instead of a blank pane.
    // Gate on visibility: background/hidden tabs (orchestration workers, CLI
    // `terminal create` without --focus) legitimately connect at 0×0 because
    // safeFit skips fitting unmeasurable panes; they refit via the pane resize
    // observer once shown, so the diagnostic must not fire while hidden.
    if ((session.cols === 0 || session.rows === 0) && session.deps.isVisibleRef.current) {
      session.deps.onPtyErrorRef?.current?.(
        session.pane.id,
        createTerminalZeroDimensionsMessage(session.cols, session.rows)
      )
    }

    session.reportError = (message: string): void => {
      // Why: the transport connect can reject asynchronously after the pane has been
      // disposed (e.g. its workspace was deleted) — dropping a late error avoids a toast
      // racing the unmount. Mirrors the connect scheduler's disposed guard above.
      if (session.disposed) {
        return
      }
      if (isWorktreeRemovalFenceError(message)) {
        // Why: main fences a spawn/reattach whose worktree (or an overlapping
        // parent/child root) is being deleted. That is expected teardown, not a
        // user-facing failure — the pane unmounts once removal completes, so never
        // surface the raw fence error. Covers the parent-removal-fences-child case
        // that startFreshSpawn's own-worktree teardown skip cannot see.
        return
      }
      session.deps.onPtyErrorRef?.current?.(session.pane.id, message)
    }
    session.codexBackfillErrorDetector =
      session.paneStartup?.launchAgent === 'codex' || session.tab?.launchAgent === 'codex'
        ? createCodexBackfillErrorDetector()
        : null

    // Why: shared registration so both fresh-spawn and reattach paths install
    // the same SerializeAddon-backed serializer plus the onTitleChange wrapper
    // that drives lastTitle parity for mobile subscribers. Wires the resulting
    // unregister into onDataDisposable.dispose so disposal stays a single
    // teardown point. See docs/mobile-prefer-renderer-scrollback.md.
    bindRegisterPaneSerializer(session)
    bindSettlePaneSerializer(session)
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
    bindForegroundOutputRefresh(session)
    bindHiddenOutputSeqAndSkip(session)
    bindHiddenRestoreState(session)
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
