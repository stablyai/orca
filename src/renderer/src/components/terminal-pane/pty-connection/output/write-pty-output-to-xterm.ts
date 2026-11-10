import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { streamDeliveryOf } from '../../pty-transport/delivery/terminal-stream-position'
import { takeCurrentTerminalDeliveryCredit } from '@/lib/pane-manager/terminal-delivery-credit'
import { nativeWindowsRewriteNeedsFollowupRenderRefresh } from '@/lib/pane-manager/terminal-complex-script'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { forceFullViewportPresent } from '@/lib/pane-manager/terminal-render-pause-release'
import { CLIENT_PLATFORM } from '@/lib/workspace/creation/new-workspace'

import { FOREGROUND_SYNCHRONIZED_FRAME_INTERACTIVE_WINDOW_MS } from './foreground-output-budgets'
import { scanSynchronizedOutput } from '../../../../../../shared/terminal/protocol/escape/terminal-synchronized-output-scan'
import { shouldWritePtyOutputForeground } from './foreground-output-visibility'
import { containsCursorRestore } from '../../../../../../shared/terminal/protocol/escape/terminal-cursor-restore'
import { containsHiddenStartupRendererQuery } from './hidden-startup-renderer-query'
import {
  noteTerminalOutputAfterInput,
  terminalInputEchoAllowanceMs
} from './terminal-input-echo-delay'

import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindWritePtyOutputToXterm(session: ConnectPanePtySession): void {
  const shouldRefreshForegroundSynchronously = (): boolean =>
    CLIENT_PLATFORM === 'win32' && session.shouldRefreshForegroundSynchronously()

  session.writePtyOutputToXterm = function (
    data: string,
    foreground: boolean,
    opts?: { hiddenStartupRendererQuery?: boolean; liveStartupBatch?: boolean }
  ): void {
    data = session.idleCursorReset.processOutput(data)
    // Why: every application byte funnels through here, so it's the one place the kitty keyboard mirror observes the pane's protocol negotiation.
    session.kittyKeyboardModes.scan(data)
    // Why before classification: this chunk may be the echo that calibrates its own window.
    if (data.length > 0) {
      noteTerminalOutputAfterInput(session.inputEchoDelay, performance.now())
    }
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
        ? scanSynchronizedOutput(
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
    // Classify each DEC 2026 start from its own open time, including same-chunk close/reopen; clear latency only when synchronization ends.
    if (synchronizedForegroundOutput && synchronizedOutputStarted) {
      session.synchronizedForegroundFrameInteractive =
        performance.now() - session.lastTerminalInputAt <=
        FOREGROUND_SYNCHRONIZED_FRAME_INTERACTIVE_WINDOW_MS +
          terminalInputEchoAllowanceMs(session.inputEchoDelay)
    } else if (!nextSynchronizedForegroundOutputActive && !synchronizedOutputEnded) {
      session.synchronizedForegroundFrameInteractive = false
    }
    // Why: ConPTY can split a submit repaint's closing chunk past the 150ms window, so treat a keystroke-opened frame as latency-sensitive to drain it fast (~16-32ms) not the 1s coalesce fallback.
    const synchronizedFrameLatencySensitive =
      synchronizedForegroundOutput && session.synchronizedForegroundFrameInteractive
    const presentInteractiveSynchronizedFrame =
      synchronizedForegroundOutput && session.synchronizedForegroundInteractivePresentPending
    if (presentInteractiveSynchronizedFrame) {
      session.synchronizedForegroundInteractivePresentPending = false
    }
    session.synchronizedForegroundOutputActive = nextSynchronizedForegroundOutputActive
    session.synchronizedForegroundMarkerTail = synchronizedForegroundScan?.markerTail ?? ''
    const startupWrite =
      opts?.liveStartupBatch && data.length > 0 ? session.startupTiming?.firstWrite() : undefined
    const onParsed = presentInteractiveSynchronizedFrame
      ? () => {
          startupWrite?.onParsed()
          forceFullViewportPresent(session.pane.terminal)
        }
      : startupWrite?.onParsed
    writeTerminalOutput(session.pane.terminal, data, {
      foreground: foregroundOutput,
      beforeWrite: startupWrite
        ? (chunk) => {
            session.beforeTerminalOutputWrite?.(chunk)
            startupWrite.beforeWrite()
          }
        : session.beforeTerminalOutputWrite,
      ...(onParsed ? { onParsed } : {}),
      // Why: every scheduler write claims one child so a split delivery is credited only after all children parse or discard.
      ackCredit: takeCurrentTerminalDeliveryCredit() ?? undefined,
      onBackgroundBacklogDropped: session.markHiddenOutputRestoreNeeded,
      // The CAN-led warning replaced queued bytes, moving xterm's parser off the stream.
      onBacklogReplaced: () => session.streamPosition.invalidate({ grounded: true }),
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
      // Merge repairs into xterm's queued frame except for Windows DOM compatibility.
      shouldRefreshForegroundSynchronously,
      stripTransientCursorShows: session.shouldProtectNativeWindowsSynchronizedOutput && foreground,
      coalesceForeground: synchronizedForegroundOutput && synchronizedOutputEnded,
      holdForeground: synchronizedForegroundOutput && nextSynchronizedForegroundOutputActive
    })
  }

  session.admitStreamBytes = (data, delivered, options) => {
    const ptyId = session.transport.getPtyId()
    if (!ptyId) {
      return data
    }
    // Remote-runtime seq counts frames, not chars, so it cannot locate a delivery in the stream.
    const delivery = streamDeliveryOf(data, delivered, {
      seqCountsChars: !isRemoteRuntimePtyId(ptyId)
    })
    const admitted = session.streamPosition.admit(ptyId, data, delivery)
    if (admitted !== null) {
      session.skippedQueryCarry = null
      return admitted
    }
    // A skipped delivery still answers its queries, including one split from the previous skip.
    const carry = session.skippedQueryCarry
    const continuesCarry =
      carry !== null &&
      carry.ptyId === ptyId &&
      typeof delivery.startSeq === 'number' &&
      carry.endSeq === delivery.startSeq
    session.skippedQueryCarry = {
      ptyId,
      endSeq: delivery.endSeq,
      pending: session.salvageRendererQueriesFromDiscardedRestoreData(
        data,
        continuesCarry ? carry.pending : ''
      )
    }
    // Skipped bytes are lost until a snapshot repaints them. Drains own that for their restore; live
    // skips ask for one, deferring to the post-flood repaint during a flood (a restore per skip is the fetch loop).
    if (options?.repairsOwnSkips !== true) {
      if (session.isForegroundRestoreBackpressureContext()) {
        session.noteHiddenOutputRestoreFloodBackpressure()
      } else if (
        !session.hiddenOutputRestoreNeeded &&
        session.hiddenOutputRestoreInFlight === null
      ) {
        session.markHiddenOutputRestoreNeeded()
      }
    }
    return null
  }

  // Orca-composed bytes (the drop sentinel's salvaged queries and mode releases) are not stream
  // bytes: they write as-is and leave xterm's parser somewhere the stream never was.
  session.admitRecoveryBytes = (data) => {
    if (data) {
      session.streamPosition.invalidate()
    }
    return data
  }

  session.queueAgentIdleTerminalModeReset = (): void => {
    if (session.disposed) {
      return
    }
    const reset = session.idleCursorReset.request()
    if (reset) {
      session.writePtyOutputToXterm(
        reset,
        shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
      )
    }
  }
}
