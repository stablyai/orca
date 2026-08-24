import { createTerminalZeroDimensionsMessage } from '../../../../../shared/terminal-zero-dimensions-diagnostic'
import { isWorktreeRemovalFenceError } from '../../../../../shared/worktree/removal-fence-error'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { createCodexBackfillErrorDetector } from '../codex-backfill-error-detector'

import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindBuildColdRestoreAgentResumeStartup } from './cold-restore-resume-startup'

import { bindPrepaintParkedSshSnapshot } from './ssh-snapshot-prepaint'
import { bindForegroundOutputRefresh } from './foreground-output-refresh'
import { bindRegisterPaneSerializer } from './pane-serializer-register'
import { bindHandleReattachResult } from './reattach-result-handler'
import { bindAttachRetainedLegacyPty } from './retained-legacy-pty-attach'
import { runDeferredSessionAttach } from './deferred-session-attach'

import { bindSerializeHiddenOutputSnapshot } from './hidden-output-snapshot-serialize'
import { bindSettlePaneSerializer } from './pane-serializer-settle'

import { bindDeferredColdRestoreAndSnapshot } from './deferred-cold-restore-and-snapshot'
import { bindHiddenOutputSeqAndSkip } from './hidden-output-seq-and-skip'
import { bindHiddenRestoreStateAndSshProbe } from './hidden-restore-state-and-ssh-probe'

export function installRunDeferredConnect(session: ConnectPanePtySession): void {
  session.runDeferredConnect = (): void => {
    if (session.connectStarted) {
      return
    }
    if (!session.startupGridSettledForConnect && session.shouldSettleStartupGridBeforeConnect()) {
      session.cancelScheduledConnectFrame()
      if (session.connectFallbackTimer !== null) {
        clearTimeout(session.connectFallbackTimer)
        session.connectFallbackTimer = null
      }
      session.settleStartupGridBeforeConnect(() => {
        session.startupGridSettledForConnect = true
        session.runDeferredConnect()
      })
      return
    }
    session.connectStarted = true
    session.cancelScheduledConnectFrame()
    if (session.connectFallbackTimer !== null) {
      clearTimeout(session.connectFallbackTimer)
      session.connectFallbackTimer = null
    }
    if (session.disposed) {
      return
    }
    safeFit(session.pane)
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
        // that startFreshSpawn's own-worktree isDeleting skip cannot see.
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

    bindSerializeHiddenOutputSnapshot(session)
    bindForegroundOutputRefresh(session)
    bindHiddenOutputSeqAndSkip(session)
    bindHiddenRestoreStateAndSshProbe(session)

    bindPrepaintParkedSshSnapshot(session)
    bindHandleReattachResult(session)
    bindAttachRetainedLegacyPty(session)
    runDeferredSessionAttach(session)
  }

  // Why: Wayland/CI compositors can starve rAF while timers/CDP stay responsive; the terminal must still start its PTY once.
  session.connectFallbackTimer = setTimeout(session.runDeferredConnect, 250)
  session.connectFrame = requestAnimationFrame(session.runDeferredConnect)
}
