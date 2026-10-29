import { replayIntoTerminal, replayIntoTerminalAsync } from '../replay-guard'
import { terminalOutputPrefersRenderRefresh } from '@/lib/pane-manager/terminal-complex-script'
import {
  buildPostReplayLiveAgentReattachReset,
  POST_REPLAY_DEAD_TUI_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  POST_REPLAY_REATTACH_RESET_KEEP_MOUSE,
  buildKittyKeyboardRestore
} from '../../../../../shared/terminal-mode-reset-profiles'
import { buildFreshShellViewportBlankingSequence } from '../../../../../shared/terminal-fresh-shell-viewport'
import { flushTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import {
  getTerminalScrollIntentKind,
  markTerminalFollowOutput
} from '@/lib/pane-manager/terminal-scroll-intent'
import { deferTerminalGeometryMutationDuringRebuild } from '@/lib/pane-manager/terminal-scroll-intent-rebuild'

import { TERMINAL_RENDERER_RISK_SCAN_TAIL_CHARS } from './foreground-output-scan'
import type { FreshSpawnOptions } from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Follow-output reset, replay writes, and fresh-shell viewport blanking. */
export function bindFreshSpawnFollowReset(session: ConnectPanePtySession): void {
  session.resetFreshSpawnFollowOutput = (): void => {
    session.cancelFreshSpawnFollowReset()
    markTerminalFollowOutput(session.pane.terminal)
    let nativeFollowResetComplete = false
    const tryResetNativeFollow = (): void => {
      if (
        session.disposed ||
        getTerminalScrollIntentKind(session.pane.terminal) !== 'followOutput' ||
        deferTerminalGeometryMutationDuringRebuild(
          session.pane.terminal,
          'fresh-spawn-follow-reset',
          tryResetNativeFollow
        )
      ) {
        return
      }
      try {
        session.pane.terminal.scrollToBottom()
        nativeFollowResetComplete = true
        session.cancelFreshSpawnFollowReset()
      } catch (err) {
        if (!(err instanceof TypeError && /dimensions/.test(err.message))) {
          session.cancelFreshSpawnFollowReset()
          throw err
        }
      }
    }
    tryResetNativeFollow()
    if (!nativeFollowResetComplete) {
      // Detached xterm viewports may reject scrolling; retry natively at first render/resize.
      session.freshSpawnFollowResetDisposables = [
        session.pane.terminal.onRender(tryResetNativeFollow),
        session.pane.terminal.onResize(tryResetNativeFollow)
      ]
    }
  }

  function trailingIncompleteCsiSequence(data: string): string {
    const escapeIndex = data.lastIndexOf('\x1b')
    if (escapeIndex === -1) {
      return ''
    }
    const tail = data.slice(escapeIndex)
    if (tail === '\x1b') {
      return tail
    }
    if (!tail.startsWith('\x1b[')) {
      return ''
    }
    for (let index = 2; index < tail.length; index++) {
      const code = tail.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) {
        return ''
      }
    }
    // Keep oversized escape prefixes intact; suffix slicing would lose the CSI introducer needed by the next scan.
    return tail.slice(0, TERMINAL_RENDERER_RISK_SCAN_TAIL_CHARS)
  }

  session.foregroundRendererRiskOutputPrefersRenderRefresh = function (data: string): boolean {
    if (!data) {
      return false
    }
    const scanData = session.foregroundRefreshRiskScanTail
      ? `${session.foregroundRefreshRiskScanTail}${data}`
      : data
    const prefersRefresh = terminalOutputPrefersRenderRefresh(scanData)
    session.foregroundRefreshRiskScanTail = trailingIncompleteCsiSequence(scanData)
    return prefersRefresh
  }

  // Hold replay guard through xterm’s parse callback so queued query replies cannot leak into shell stdin.
  session.writeReplayData = (data: string): void => {
    // Drain old background bytes before replay so deferred writes cannot overwrite the new image.
    flushTerminalOutput(session.pane.terminal)
    data = session.idleCursorReset.processOutput(data)
    replayIntoTerminal(session.pane, session.deps.replayingPanesRef, data, {
      breadcrumbIdentity: {
        tabId: session.deps.tabId,
        worktreeId: session.deps.worktreeId,
        ptyId: session.transport.getPtyId()
      },
      shouldRefreshViewportSynchronously: session.shouldRefreshForegroundSynchronously,
      shouldReleaseRenderPause: () => session.deps.isVisibleRef.current
    })
  }

  session.writeReplayDataAsync = (data: string): Promise<void> => {
    // Rebuild WebGL after replay parses, rather than when it is merely queued.
    flushTerminalOutput(session.pane.terminal)
    data = session.idleCursorReset.processOutput(data)
    return replayIntoTerminalAsync(session.pane, session.deps.replayingPanesRef, data, {
      breadcrumbIdentity: {
        tabId: session.deps.tabId,
        worktreeId: session.deps.worktreeId,
        ptyId: session.transport.getPtyId()
      },
      shouldRefreshViewportSynchronously: session.shouldRefreshForegroundSynchronously,
      shouldReleaseRenderPause: () => session.deps.isVisibleRef.current
    })
  }

  // Why one writer: the kitty mirror and xterm must parse every renderer-originated mode byte alike.
  session.writeInputModeGround = (data: string): void => {
    session.kittyKeyboardModes.scan(data)
    session.writeReplayData(data)
  }

  /**
   * Writes a post-replay reset ending in the mirror's Kitty flags, through the
   * mirror first. The restore is built after scanning the profile because its
   * `?1049l` moves both records to the other screen's slot.
   */
  session.writeReplayEpilogue = <T>(
    profile: string,
    write: (data: string) => T = session.writeReplayData
  ): T => {
    session.kittyKeyboardModes.scan(profile)
    const kitty = buildKittyKeyboardRestore(session.kittyKeyboardModes.snapshotFlags)
    session.kittyKeyboardModes.scan(kitty)
    return write(`${profile}${kitty}`)
  }

  /** Picks the post-replay reset profile for a reattach; the caller writes it via writeReplayEpilogue. */
  session.chooseReattachReplayReset = (
    payload: string,
    ownerProcessEnded = false,
    isAlternateScreen?: boolean,
    terminalOwner?: 'shell'
  ): string => {
    // Cold restore replaces the dead process despite persisted agent titles/status; clear stale mouse/focus/paste modes before the fresh shell (#12101).
    if (ownerProcessEnded) {
      return POST_REPLAY_MODE_RESET
    }
    if (terminalOwner === 'shell') {
      return (isAlternateScreen ?? session.kittyKeyboardModes.isAlternateScreen)
        ? POST_REPLAY_DEAD_TUI_RESET
        : POST_REPLAY_REATTACH_RESET
    }
    if (session.shouldPreserveAgentReattachModes()) {
      return buildPostReplayLiveAgentReattachReset(payload)
    }
    // Alt-screen panes can be live unrecognized TUIs; preserve mouse modes the replay restored (#8291).
    return (isAlternateScreen ?? session.kittyKeyboardModes.isAlternateScreen)
      ? POST_REPLAY_REATTACH_RESET_KEEP_MOUSE
      : POST_REPLAY_REATTACH_RESET
  }

  session.consumeRestoredViewportBlankingMarker = (): boolean => {
    return session.deps.restoredViewportBlankingPanesRef?.current.delete(session.pane.id) ?? false
  }

  session.writeFreshShellViewportBlanking = (rows = session.pane.terminal.rows): void => {
    session.writeReplayData(buildFreshShellViewportBlankingSequence(rows))
  }

  session.prepareFreshShellViewportForSpawn = (options: FreshSpawnOptions): void => {
    const hadRestoredViewport = session.consumeRestoredViewportBlankingMarker()
    if (!options.forceBlankRestoredViewport && !hadRestoredViewport) {
      return
    }
    // Move restored rows into scrollback before coordinate-based Windows ConPTY prompt output.
    session.writeFreshShellViewportBlanking()
  }
}
