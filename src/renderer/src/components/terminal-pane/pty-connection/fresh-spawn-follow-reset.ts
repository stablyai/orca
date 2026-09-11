import { replayIntoTerminal, replayIntoTerminalAsync } from '../replay-guard'
import { terminalOutputPrefersRenderRefresh } from '@/lib/pane-manager/terminal-complex-script'
import {
  buildPostReplayLiveAgentReattachReset,
  POST_REPLAY_DEAD_TUI_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  POST_REPLAY_REATTACH_RESET_KEEP_MOUSE
} from '../../../../../shared/terminal-mode-reset-profiles'
import { buildFreshShellViewportBlankingSequence } from '../terminal-restored-viewport'
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
      // Why: xterm's browser viewport can reject scrolling while its renderer
      // is detached; the first render/resize is the earliest safe native retry.
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
    // Why: keep the head — a suffix slice of an oversized parameter run drops
    // the `\x1b[` the next scan needs to recognize the carried sequence.
    return tail.slice(0, TERMINAL_RENDERER_RISK_SCAN_TAIL_CHARS)
  }

  session.foregroundRendererRiskOutputPrefersRenderRefresh = function (data: string): boolean {
    if (!data) {
      return false
    }
    const scanData = session.foregroundRefreshRiskScanTail
      ? `${session.foregroundRefreshRiskScanTail}${data}`
      : data
    const prefersRefresh =
      (scanData.includes('\x1b[') || session.containsNonAsciiOutput(scanData)) &&
      terminalOutputPrefersRenderRefresh(scanData)
    session.foregroundRefreshRiskScanTail = trailingIncompleteCsiSequence(scanData)
    return prefersRefresh
  }

  // The replay path uses the guard so xterm auto-replies to embedded query
  // sequences don't leak into the shell. xterm.write() buffers internally
  // regardless of DOM visibility and the guard stays engaged via the
  // write-completion callback until xterm finishes parsing.
  session.writeReplayData = (data: string): void => {
    // Why: drain any queued background bytes BEFORE the replay paint, so the
    // scheduler's deferred drain cannot land older bytes on top of the replay.
    flushTerminalOutput(session.pane.terminal)
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
    // Why: WebGL must be rebuilt after xterm has parsed replay bytes, not
    // merely after the write was queued.
    flushTerminalOutput(session.pane.terminal)
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

  session.reattachReplayResetSequence = (
    payload: string,
    ownerProcessEnded = false,
    isAlternateScreen?: boolean,
    terminalOwner?: 'shell'
  ): string => {
    // Why a cold restore overrides the agent signal: liveness is read from the
    // pane's status and title, both of which are persisted, so after a cold
    // restore they describe the process that died. Preserving "its" modes arms
    // mouse, focus and paste reporting against the fresh shell that replaces it,
    // which then prints the reports as junk at the prompt (#12101).
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
    // Why: an alt-screen pane is a live TUI Orca just does not recognise as an agent, and the
    // replay already re-armed its mouse modes — keep them instead of wiping them (#8291).
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
    // Why: fresh Windows ConPTY output paints at screen coordinates, so
    // restored rows must leave the viewport before the first prompt redraw.
    session.writeFreshShellViewportBlanking()
  }
}
