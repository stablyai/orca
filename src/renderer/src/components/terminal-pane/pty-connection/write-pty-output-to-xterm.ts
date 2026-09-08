import { takeCurrentTerminalDeliveryCredit } from '@/lib/pane-manager/terminal-delivery-credit'
import { nativeWindowsRewriteNeedsFollowupRenderRefresh } from '@/lib/pane-manager/terminal-complex-script'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'

import { FOREGROUND_SYNCHRONIZED_FRAME_INTERACTIVE_WINDOW_MS } from './foreground-output-budgets'
import {
  shouldWritePtyOutputForeground,
  scanSynchronizedForegroundOutput,
  containsCursorRestore
} from './foreground-output-scan'
import { containsHiddenStartupRendererQuery } from './hidden-startup-renderer-query'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** The xterm write path for PTY output, including the queued agent-idle mode reset. */
export function bindWritePtyOutputToXterm(session: ConnectPanePtySession): void {
  session.writePtyOutputToXterm = function (
    data: string,
    foreground: boolean,
    opts?: { hiddenStartupRendererQuery?: boolean }
  ): void {
    // Why: every application byte funnels through here, so it's the one place the kitty keyboard mirror observes the pane's protocol negotiation.
    session.kittyKeyboardModes.scan(data)
    if (foreground) {
      session.resetHiddenOutputRestoreIfPtyChanged()
    }
    const parseHiddenStartupOutput =
      !foreground &&
      session.canUseHiddenOutputSnapshot(session.transport.getPtyId()) &&
      session.shouldSnapshotHiddenCodexOutput &&
      (opts?.hiddenStartupRendererQuery === true || containsHiddenStartupRendererQuery(data))
    const synchronizedForegroundScan =
      session.shouldProtectNativeWindowsSynchronizedOutput && foreground
        ? scanSynchronizedForegroundOutput(
            data,
            session.synchronizedForegroundMarkerTail,
            session.synchronizedForegroundOutputActive
          )
        : null
    const synchronizedOutputStarted = synchronizedForegroundScan?.started === true
    const synchronizedOutputEnded = synchronizedForegroundScan?.ended === true
    const synchronizedForegroundOutput =
      synchronizedForegroundScan !== null &&
      (session.synchronizedForegroundOutputActive ||
        synchronizedOutputStarted ||
        synchronizedOutputEnded)
    const nextSynchronizedForegroundOutputActive = synchronizedForegroundScan?.active === true
    // Why: xterm's DOM renderer draws the cursor as row content, so Windows cursor-only restores need row invalidation even outside DEC 2026.
    const nativeWindowsCursorRestore =
      session.shouldProtectNativeWindowsSynchronizedOutput &&
      foreground &&
      containsCursorRestore(data)
    const foregroundOutput = foreground || parseHiddenStartupOutput
    if (foreground) {
      session.scheduleForegroundGridDriftCheck()
    }
    const renderRefreshDecision = foregroundOutput
      ? session.shouldForceForegroundRenderRefresh(data)
      : { refresh: false, inPlaceRewrite: false }
    const foregroundRenderRefreshNeeded = renderRefreshDecision.refresh
    // Why: Claude Code's in-place prompt redraws on Windows ConPTY can paint one frame late; a follow-up repaint fixes the column desync without a resize.
    const nativeWindowsInPlaceRewriteFollowup = nativeWindowsRewriteNeedsFollowupRenderRefresh({
      isNativeWindowsConpty: session.shouldApplyNativeWindowsRewriteRefresh,
      isForeground: foreground,
      isInPlaceRewrite: renderRefreshDecision.inPlaceRewrite
    })
    // Why: recompute the latch on every synchronized START so each frame's interactivity is judged by its own open time and can't leak across a same-chunk close+open; clear only on leaving synchronized output.
    if (synchronizedForegroundOutput && synchronizedOutputStarted) {
      session.synchronizedForegroundFrameInteractive =
        performance.now() - session.lastTerminalInputAt <=
        FOREGROUND_SYNCHRONIZED_FRAME_INTERACTIVE_WINDOW_MS
    } else if (!nextSynchronizedForegroundOutputActive && !synchronizedOutputEnded) {
      session.synchronizedForegroundFrameInteractive = false
    }
    // Why: ConPTY can split a submit repaint's closing chunk past the 150ms window, so treat a keystroke-opened frame as latency-sensitive to drain it fast (~16-32ms) not the 1s coalesce fallback.
    const synchronizedFrameLatencySensitive =
      synchronizedForegroundOutput && session.synchronizedForegroundFrameInteractive
    session.synchronizedForegroundOutputActive = nextSynchronizedForegroundOutputActive
    session.synchronizedForegroundMarkerTail = synchronizedForegroundScan?.markerTail ?? ''
    writeTerminalOutput(session.pane.terminal, data, {
      foreground: foregroundOutput,
      beforeWrite: session.beforeTerminalOutputWrite,
      // Why: every scheduler write claims one child so a split delivery is credited only after all children parse or discard.
      ackCredit: takeCurrentTerminalDeliveryCredit() ?? undefined,
      onBackgroundBacklogDropped: session.markHiddenOutputRestoreNeeded,
      latencySensitive:
        !foreground || parseHiddenStartupOutput
          ? true
          : synchronizedFrameLatencySensitive || session.isLatencySensitiveForegroundOutput(data),
      forceForegroundRefresh:
        foregroundOutput &&
        (synchronizedForegroundOutput ||
          nativeWindowsCursorRestore ||
          foregroundRenderRefreshNeeded),
      followupForegroundRefresh: nativeWindowsCursorRestore || nativeWindowsInPlaceRewriteFollowup,
      // Why: xterm already queued a WebGL frame parsing this chunk; merge the repair into it instead of rendering the grid twice.
      shouldRefreshForegroundSynchronously: session.shouldRefreshForegroundSynchronously,
      stripTransientCursorShows: session.shouldProtectNativeWindowsSynchronizedOutput && foreground,
      coalesceForeground: synchronizedForegroundOutput && synchronizedOutputEnded,
      holdForeground: synchronizedForegroundOutput && nextSynchronizedForegroundOutputActive
    })
  }

  session.queueAgentIdleTerminalModeReset = (): void => {
    if (session.disposed) {
      return
    }
    session.writePtyOutputToXterm(
      session.idleAgentTerminalModeReset,
      shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
    )
  }
}
