import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  terminalRewriteOutputRenderRefreshDecision,
  terminalRewriteOutputPrefersRenderRefresh,
  windowsEastAsianOutputPrefersRenderRefresh
} from '@/lib/pane-manager/terminal-rendering/terminal-complex-script'
import { recordTerminalOutput } from '@/lib/pane-manager/terminal-scroll/pane-scroll'
import { ensureArabicShapingJoinerForText } from '@/lib/pane-manager/terminal-rendering/terminal-arabic-shaping-joiner'
import {
  acquireHiddenRendererPtyDeliveryClaim,
  declareRendererPtyDeliveryVisible
} from '../../pty-transport/delivery/pty-renderer-delivery-claims'

import { HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS } from '../output-restore/hidden-output-restore-limits'
import {
  FOREGROUND_THROUGHPUT_IMMEDIATE_CHARS,
  FOREGROUND_INTERACTIVE_REDRAW_CHARS,
  FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS,
  FOREGROUND_IMMEDIATE_BUDGET_CHARS,
  consumeForegroundImmediateBudget,
  consumeInactiveForegroundImmediateBudget
} from './foreground-output-budgets'
import { shouldWritePtyOutputForeground } from './foreground-output-visibility'
import { syncRemoteOutputCadence } from './remote-output-cadence'
import { bindHiddenGraphicsDelivery } from './hidden-graphics-delivery'
import { bindModelRestoreNeededSubscription } from './model-restore-needed-subscription'

import { terminalInputEchoAllowanceMs } from './terminal-input-echo-delay'

import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindForegroundOutputRefresh(session: ConnectPanePtySession): void {
  // Extends the suppression window; every backpressure signal resets the timer so the deferred repaint fires once, SUPPRESS_MS after the last signal.
  session.noteHiddenOutputRestoreFloodBackpressure = function (): void {
    session.extendHiddenOutputRestoreFloodSuppression()
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

  const syncModelRestoreNeededSubscription = bindModelRestoreNeededSubscription(session)

  session.handleRemoteOutputPauseChanged = (paused, supported, dropsReported): void => {
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
    // Why: a host that reports drops lets a quiet pane reveal with zero snapshot fetches; others may have dropped anything.
    if (!(supported && dropsReported)) {
      session.markHiddenOutputRestoreNeeded()
    }
  }

  session.handleRemotePausedOutputDropped = (): void => {
    const ptyId = session.transport.getPtyId()
    if (session.disposed || !ptyId || !isRemoteRuntimePtyId(ptyId)) {
      return
    }
    // Why: the gap invalidates cross-chunk carry, exactly like a local drop marker.
    session.transport.resetCrossChunkParserState?.()
    const restoreWasInFlight = session.hiddenOutputRestoreInFlight !== null
    session.markHiddenOutputRestoreNeeded()
    if (restoreWasInFlight) {
      session.hiddenOutputRestoreFreshSnapshotNeeded = true
    }
  }

  let claimRetainsGraphics = false
  const hiddenGraphics = bindHiddenGraphicsDelivery(session)
  session.syncHiddenRendererPtyDelivery = (relayReplayNeeded = false): void => {
    const ptyId = session.transport.getPtyId()
    const shouldHide =
      !session.disposed && !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
    const canSnapshot = session.canUseHiddenOutputSnapshot(ptyId)
    // COMPAT(legacy-relay-bridge): paused panes recover from the relay's screen on reveal.
    const transportGate =
      (ptyId !== null && ptyId === session.legacyRelayBridgePtyId) ||
      (isRemoteRuntimePtyId(ptyId) && canSnapshot)
    const mainGate = !transportGate && canSnapshot && session.isHiddenDeliveryGateManagedPty(ptyId)
    const retain = hiddenGraphics.sync(ptyId, shouldHide, transportGate, mainGate)
    syncModelRestoreNeededSubscription(ptyId)
    syncRemoteOutputCadence(session)
    if (session.remoteOutputGatedPtyId !== null && session.remoteOutputGatedPtyId !== ptyId) {
      session.remoteOutputGatedPtyId = null
      if (!session.mainSideEffectAuthority) {
        session.dropSideEffectFactConsumer()
      }
    }
    if (session.hiddenDeliverySyncedPtyId !== ptyId || !mainGate) {
      session.releaseHiddenDeliveryClaim?.()
      session.releaseHiddenDeliveryClaim = null
      session.hiddenDeliverySyncedPtyId = null
    }
    if (transportGate) {
      if (relayReplayNeeded) {
        session.transport.setOutputPaused?.(true, true)
      } else {
        session.transport.setOutputPaused?.(shouldHide && !retain)
      }
      return
    }
    if (!ptyId || !mainGate) {
      return
    }
    if (shouldHide) {
      const previous = session.releaseHiddenDeliveryClaim
      if (!previous || claimRetainsGraphics !== retain) {
        // Replace the graphics flag without briefly revealing a still-hidden PTY.
        session.releaseHiddenDeliveryClaim = acquireHiddenRendererPtyDeliveryClaim(ptyId, retain)
        claimRetainsGraphics = retain
        previous?.()
      }
    } else if (session.releaseHiddenDeliveryClaim) {
      session.releaseHiddenDeliveryClaim()
      session.releaseHiddenDeliveryClaim = null
    } else if (session.hiddenDeliverySyncedPtyId !== ptyId) {
      // Why: clear unconditionally on first sync — a stale main-side hidden bit can survive a renderer reload for daemon-backed PTYs that keep their session id.
      declareRendererPtyDeliveryVisible(ptyId)
    }
    session.hiddenDeliverySyncedPtyId = ptyId
  }
  session.releaseHiddenRendererPtyDelivery = (): void => {
    hiddenGraphics.release()
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
      FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS + terminalInputEchoAllowanceMs(session.inputEchoDelay)
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
      FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS + terminalInputEchoAllowanceMs(session.inputEchoDelay)
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
