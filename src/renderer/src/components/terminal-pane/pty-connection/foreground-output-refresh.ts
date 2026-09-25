import { recordTerminalFreezeBreadcrumb } from '../terminal-freeze-breadcrumbs'
import { redactPtyIdForDiagnostics } from '../../../../../shared/pty-delivery-diagnostics'
import {
  terminalRewriteOutputRenderRefreshDecision,
  terminalRewriteOutputPrefersRenderRefresh,
  windowsEastAsianOutputPrefersRenderRefresh
} from '@/lib/pane-manager/terminal-complex-script'
import { RESET_AFTER_BYTE_GAP } from '../../../../../shared/terminal-mode-reset-profiles'
import { recordTerminalOutput } from '@/lib/pane-manager/pane-scroll'
import { ensureArabicShapingJoinerForText } from '@/lib/pane-manager/terminal-arabic-shaping-joiner'
import { registerPtyModelRestoreNeededHandler } from '../pty-model-restore-channel'
import {
  acquireHiddenRendererPtyDeliveryClaim,
  declareRendererPtyDeliveryVisible
} from '../pty-renderer-delivery-claims'

import { HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS } from './hidden-output-restore-limits'
import {
  FOREGROUND_THROUGHPUT_IMMEDIATE_CHARS,
  FOREGROUND_INTERACTIVE_REDRAW_CHARS,
  FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS,
  FOREGROUND_IMMEDIATE_BUDGET_CHARS,
  consumeForegroundImmediateBudget
} from './foreground-output-budgets'
import {
  shouldWritePtyOutputForeground,
  consumeInactiveForegroundImmediateBudget
} from './foreground-output-scan'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindForegroundOutputRefresh(session: ConnectPanePtySession): void {
  // Extends the suppression window; every backpressure signal resets the timer so the deferred repaint fires once, SUPPRESS_MS after the last signal.
  session.noteHiddenOutputRestoreFloodBackpressure = function (): void {
    session.hiddenOutputRestoreFloodSuppressedUntil =
      Date.now() + HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS
    const ptyId = session.transport.getPtyId()
    if (ptyId === null) {
      return
    }
    session.clearHiddenOutputRestoreFloodRepaintTimer()
    session.hiddenOutputRestoreFloodRepaintTimer = setTimeout(() => {
      session.hiddenOutputRestoreFloodRepaintTimer = null
      if (session.disposed || session.transport.getPtyId() !== ptyId) {
        return
      }
      // Why one repaint: flood-dropped bytes leave a gap the live stream can't heal; once quiet, one snapshot restore repaints from main's authoritative buffer.
      session.repaintAfterFloodWhenFollowingOutput(ptyId)
    }, HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS)
  }

  // Why: main reports dropped renderer-bound bytes out-of-band, routed per PTY by pty-model-restore-channel.ts.
  function handleModelRestoreNeededMarker(): void {
    if (session.disposed) {
      return
    }
    recordTerminalFreezeBreadcrumb('restore-marker', {
      id: redactPtyIdForDiagnostics(session.transport.getPtyId() ?? '')
    })
    // Why: dropped bytes invalidate cross-chunk carry — a partial OSC-9999 prefix spanning the gap would corrupt the next live chunk.
    session.transport.resetCrossChunkParserState?.()
    // Why gated (rc.7.perf loop): on a visible pane these markers come from our own restore starving ACKs; re-arming per marker kept the fetch loop alive all flood, so defer to one post-flood repaint.
    if (session.isForegroundRestoreBackpressureContext()) {
      session.noteHiddenOutputRestoreFloodBackpressure()
      return
    }
    // Why the emulator too: it carries state across chunks exactly like the
    // parser does. If the gap swallowed the `ESC[22m` closing a bold run,
    // every cell written afterwards inherits it. This marker is the one point
    // where "bytes were dropped" is known, so ground the pen here rather than
    // relying on each recovery path to remember (STA-4042).
    // Why after the backpressure return and not before: under flood these
    // markers arrive continuously, and writing per marker would add work in
    // exactly the case that guard exists to damp. The flood path repaints via
    // session.buildMainModelSnapshotReplayWrites, which grounds the pen itself, so
    // nothing is lost by skipping it here.
    session.writePtyOutputToXterm(RESET_AFTER_BYTE_GAP, true)
    // Why: a marker during an in-flight restore means that snapshot may predate the drop, so a fresh one must follow; capture BEFORE the mark, which starts a restore synchronously on a visible pane.
    const restoreWasInFlight = session.hiddenOutputRestoreInFlight !== null
    session.markHiddenOutputRestoreNeeded()
    if (restoreWasInFlight) {
      session.hiddenOutputRestoreFreshSnapshotNeeded = true
    }
  }

  function syncModelRestoreNeededSubscription(ptyId: string | null): void {
    if (session.modelRestoreSubscribedPtyId === ptyId) {
      return
    }
    session.unregisterModelRestoreNeeded?.()
    session.unregisterModelRestoreNeeded = null
    session.modelRestoreSubscribedPtyId = ptyId
    // Why: markers exist only for PTYs whose bytes transit local main;
    // remote-runtime transports are structurally unaffected.
    if (!ptyId || isRemoteRuntimePtyId(ptyId)) {
      return
    }
    session.unregisterModelRestoreNeeded = registerPtyModelRestoreNeededHandler(
      ptyId,
      handleModelRestoreNeededMarker
    )
  }

  session.handleRemoteOutputPauseChanged = (paused, supported): void => {
    const ptyId = session.transport.getPtyId()
    if (!ptyId || !isRemoteRuntimePtyId(ptyId)) {
      return
    }
    if (!paused) {
      const wasGated = session.remoteOutputGatedPtyId === ptyId
      if (wasGated) {
        session.remoteOutputGatedPtyId = null
        if (!session.mainSideEffectAuthority) {
          session.dropSideEffectFactConsumer()
        }
      }
      if (wasGated && session.hiddenOutputRestorePtyId === ptyId) {
        session.requestHiddenOutputRestoreIfNeeded()
      }
      return
    }
    if (session.remoteOutputGatedPtyId !== ptyId) {
      session.remoteOutputGatedPtyId = ptyId
    }
    if (supported && session.remoteOutputFactConsumerPtyId !== ptyId) {
      session.registerSideEffectFactConsumerForPty(ptyId, true)
      session.remoteOutputFactConsumerPtyId = ptyId
    }
    session.markHiddenOutputRestoreNeeded()
  }

  session.syncHiddenRendererPtyDelivery = (): void => {
    const ptyId = session.transport.getPtyId()
    syncModelRestoreNeededSubscription(ptyId)
    if (session.remoteOutputGatedPtyId !== null && session.remoteOutputGatedPtyId !== ptyId) {
      session.remoteOutputGatedPtyId = null
      if (!session.mainSideEffectAuthority) {
        session.dropSideEffectFactConsumer()
      }
    }
    if (isRemoteRuntimePtyId(ptyId) && session.canUseHiddenOutputSnapshot(ptyId)) {
      session.transport.setOutputPaused?.(
        !session.disposed && !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
      )
      return
    }
    if (session.hiddenDeliverySyncedPtyId !== null && session.hiddenDeliverySyncedPtyId !== ptyId) {
      session.releaseHiddenDeliveryClaim?.()
      session.releaseHiddenDeliveryClaim = null
      session.hiddenDeliverySyncedPtyId = null
    }
    if (
      !session.isHiddenDeliveryGateManagedPty(ptyId) ||
      !session.canUseHiddenOutputSnapshot(ptyId)
    ) {
      return
    }
    const shouldHide =
      !session.disposed && !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
    const isFirstSyncForPty = session.hiddenDeliverySyncedPtyId !== ptyId
    session.hiddenDeliverySyncedPtyId = ptyId
    if (shouldHide) {
      if (!session.releaseHiddenDeliveryClaim) {
        session.releaseHiddenDeliveryClaim = acquireHiddenRendererPtyDeliveryClaim(ptyId)
      }
    } else if (session.releaseHiddenDeliveryClaim) {
      session.releaseHiddenDeliveryClaim()
      session.releaseHiddenDeliveryClaim = null
    } else if (isFirstSyncForPty) {
      // Why: clear unconditionally on first sync — a stale main-side hidden bit can survive a renderer reload for daemon-backed PTYs that keep their session id.
      declareRendererPtyDeliveryVisible(ptyId)
    }
  }
  session.releaseHiddenRendererPtyDelivery = (): void => {
    session.transport.setOutputPaused?.(false)
    if (session.remoteOutputGatedPtyId !== null) {
      session.remoteOutputGatedPtyId = null
      if (!session.mainSideEffectAuthority) {
        session.dropSideEffectFactConsumer()
      }
    }
    session.releaseHiddenDeliveryClaim?.()
    session.releaseHiddenDeliveryClaim = null
    session.hiddenDeliverySyncedPtyId = null
    session.unregisterModelRestoreNeeded?.()
    session.unregisterModelRestoreNeeded = null
    session.modelRestoreSubscribedPtyId = null
  }

  session.beforeTerminalOutputWrite = function (data: string): void {
    // Why: shaping must register before xterm parses the RTL bytes that need it.
    ensureArabicShapingJoinerForText(session.pane.terminal, data)
    recordTerminalOutput(session.pane.terminal)
  }

  session.consumeForegroundImmediateBudget = function (dataLength: number): boolean {
    return consumeForegroundImmediateBudget(
      session.foregroundImmediateBudget,
      dataLength,
      FOREGROUND_IMMEDIATE_BUDGET_CHARS
    )
  }

  session.isActiveSplitPane = function (): boolean {
    if (!session.deps.isActiveRef.current) {
      return false
    }
    const activePane = session.manager.getActivePane?.() ?? null
    return activePane ? activePane.id === session.pane.id : true
  }

  session.isLatencySensitiveForegroundOutput = function (data: string): boolean {
    if (!session.isActiveSplitPane()) {
      // Why: many visible split panes each emit tiny TUI frames; a shared budget keeps them live without letting aggregate xterm work starve typing in the active pane.
      if (data.includes('\x1b[')) {
        return false
      }
      return consumeInactiveForegroundImmediateBudget(data.length)
    }
    if (data.length <= FOREGROUND_THROUGHPUT_IMMEDIATE_CHARS) {
      return session.consumeForegroundImmediateBudget(data.length)
    }
    const recentInput =
      performance.now() - session.lastInteractiveRedrawInputAt <=
      FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS
    if (
      recentInput &&
      data.length <= FOREGROUND_INTERACTIVE_REDRAW_CHARS &&
      data.includes('\x1b[')
    ) {
      return session.consumeForegroundImmediateBudget(data.length)
    }
    return false
  }

  session.containsNonAsciiOutput = function (data: string): boolean {
    for (let index = 0; index < data.length; index++) {
      if (data.charCodeAt(index) > 0x7f) {
        return true
      }
    }
    return false
  }

  function containsWindowsRewriteControl(data: string): boolean {
    return data.includes('\r') || terminalRewriteOutputPrefersRenderRefresh(data)
  }

  session.foregroundRewriteOutputPrefersRenderRefresh = function (data: string): boolean {
    const decision = terminalRewriteOutputRenderRefreshDecision(data, {
      previousChunkEndsWithCarriageReturn: session.foregroundRewriteChunkEndedWithCarriageReturn,
      previousRewriteCsiScanTail: session.foregroundRewriteCsiScanTail
    })
    session.foregroundRewriteChunkEndedWithCarriageReturn = decision.nextChunkEndsWithCarriageReturn
    session.foregroundRewriteCsiScanTail = decision.nextRewriteCsiScanTail
    return decision.prefersRenderRefresh
  }

  session.shouldForceForegroundRenderRefresh = function (data: string): {
    refresh: boolean
    inPlaceRewrite: boolean
  } {
    const rewriteOutputPrefersRenderRefresh =
      session.foregroundRewriteOutputPrefersRenderRefresh(data)
    const recentInput =
      performance.now() - session.lastInteractiveRedrawInputAt <=
      FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS
    if (session.foregroundRendererRiskOutputPrefersRenderRefresh(data)) {
      return {
        refresh: true,
        inPlaceRewrite: rewriteOutputPrefersRenderRefresh
      }
    }
    if (rewriteOutputPrefersRenderRefresh) {
      // Why: xterm's buffer is right but in-place redraw cells stay stale in the renderer until a repaint (resize fixes it).
      return { refresh: true, inPlaceRewrite: true }
    }
    if (
      windowsEastAsianOutputPrefersRenderRefresh(data, {
        isWindowsClient: session.shouldApplyWindowsRendererUnicodeRefresh,
        isNativeWindowsConpty: session.shouldApplyNativeWindowsRewriteRefresh,
        hadRecentInput: recentInput,
        maxInteractiveRedrawChars: FOREGROUND_INTERACTIVE_REDRAW_CHARS
      })
    ) {
      // Why: CJK/Korean from Microsoft Pinyin commits and native ConPTY output can leave stale wide-glyph cells in the Windows DOM renderer.
      return { refresh: true, inPlaceRewrite: false }
    }
    return {
      refresh:
        session.shouldApplyNativeWindowsRewriteRefresh &&
        session.containsNonAsciiOutput(data) &&
        containsWindowsRewriteControl(data),
      inPlaceRewrite: false
    }
  }
}
