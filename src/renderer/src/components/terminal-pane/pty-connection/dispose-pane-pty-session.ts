import { cancelPendingSafeFitContinuations } from '@/lib/pane-manager/pane-tree-ops'
import { PANE_PTY_RESIZE_HOLD_FLUSH_EVENT } from '@/lib/pane-manager/pane-pty-resize-hold'
import { discardTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { releaseRendererPtyVisibilityClaim } from '../pty-renderer-delivery-claims'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function disposePanePtySession(session: ConnectPanePtySession): void {
  if (session.disposed) {
    return
  }
  session.disposed = true
  let failure: unknown
  const finish = (cleanup: () => void): void => {
    try {
      cleanup()
    } catch (error) {
      failure ??= error
    }
  }
  finish(() => session.onDataDisposable.dispose())
  finish(() => session.discardAgentPreReadyDraft?.())
  finish(() => session.cleanupKittyFileReader())
  finish(() => session.disposeSpawnDeferral())
  finish(() => session.startupTiming?.finish('disposed'))
  finish(() => {
    const unsentReplacedPtyId: string | null = session.claimPendingReplacedPtyId()
    if (unsentReplacedPtyId) {
      // Why: no spawn will carry this stop now, and the pane no longer references the PTY.
      void Promise.resolve()
        .then(() => window.api.pty.kill(unsentReplacedPtyId))
        .catch((err: unknown) => console.warn('[terminal] failed to stop a replaced PTY:', err))
    }
  })
  // Successors may reuse numeric pane slots before disposal; leave their errors untouched.
  const currentPaneTransport = session.deps.paneTransportsRef.current.get(session.pane.id)
  if (!currentPaneTransport || currentPaneTransport === session.transport) {
    finish(() => session.deps.onPtyErrorClearedRef?.current?.(session.pane.id))
  }
  // Detached observers cede byte-derived agent-status authority to the host’s next mirror snapshot.
  finish(() => session.releaseRendererOwnedAgentStatusPane?.())
  // Why: a stalled xterm replay may never reach its finally; release live-frame credit when this renderer no longer owns the stream.
  const queue = session.deferredReattachLiveData
  session.deferredReattachLiveData = null
  finish(() => queue?.discard())
  session.reattachLiveDataDeferralDepth = 0
  session.deferredReattachLiveDataOwners = new Map()
  finish(() => cancelPendingSafeFitContinuations(session.pane))
  session.pendingHiddenSnapshotFit = null
  session.pendingReattachFit = null
  // Why: park/reconnect/remount doesn't advance the recovery epoch, so invalidate this xterm or its delayed retry could hit the next instance.
  finish(() => session.terminalRecoveryInstance.unregister())
  finish(() => session.unregisterUndeliverableWriteHandler())
  finish(() => session.unsubscribeRemoteDesktopActivationClaim())
  finish(() => session.cancelHiddenOutputSnapshotScrollRestore())
  const liveScrollbackRestore = session.liveScrollbackRestore
  session.liveScrollbackRestore = null
  finish(() => liveScrollbackRestore?.dispose())
  finish(() => session.structuralReplayCoordinator.dispose())
  finish(() => session.cancelFreshSpawnFollowReset())
  // Why: cancel the post-spawn reconcile's pending rAF so a torn-down pane can't keep fitting/resizing after disposal.
  const ptySizeReconcileHandle = session.ptySizeReconcileHandle
  session.ptySizeReconcileHandle = null
  finish(() => ptySizeReconcileHandle?.cancel())
  finish(() => session.ptySizeReassertion.dispose())
  const terminalSelectionFitGuard = session.terminalSelectionFitGuard
  session.terminalSelectionFitGuard = null
  finish(() => terminalSelectionFitGuard?.dispose())
  if (session.pendingForegroundGridDriftCheckRaf !== null) {
    cancelAnimationFrame(session.pendingForegroundGridDriftCheckRaf)
    session.pendingForegroundGridDriftCheckRaf = null
  }
  finish(() => session.clearForegroundGridDriftTrailingProbe())
  // Why: a pane unmount must never leave its PTY delivery gated — the parked watcher or remounted pane re-decides.
  finish(() => session.releaseHiddenRendererPtyDelivery())
  if (session.terminalKeyTargetSupportsEvents) {
    finish(() =>
      session.terminalKeyTarget.removeEventListener('keydown', session.onTerminalKeyDown, {
        capture: true
      })
    )
  }
  finish(() => session.clearPendingTerminalInputIntent())
  session.pendingTerminalInputWrite = null
  finish(() => session.interruptInference.dispose())
  finish(() => session.clearTitleOnlyInterruptTimer())
  // Release without cancelling the turn’s settle deadline so the parked watcher inherits it.
  finish(() => session.releaseCommandCodeDoneSettleExecutor())
  if (session.shiftEnterReconfirmTimer !== null) {
    clearTimeout(session.shiftEnterReconfirmTimer)
    session.shiftEnterReconfirmTimer = null
  }
  // Why: resolve in-flight passphrase-gate waits so their zustand subscribers + async IIFEs don't hang when the pane is torn down before SSH state changes.
  while (session.waitTeardowns.length > 0) {
    const teardown = session.waitTeardowns.pop()
    finish(() => teardown?.())
  }
  if (session.startupInjectTimer !== null) {
    clearTimeout(session.startupInjectTimer)
    session.startupInjectTimer = null
  }
  finish(() => session.cleanupStartupDraftPasteTimers())
  finish(() => session.releaseUnattemptedStartupDraftPasteDelivery())
  finish(() => session.unregisterAgentHookTerminalLifecycle())
  finish(() => session.clearSuppressedTitleSideEffects())
  finish(() => session.clearPendingAgentTaskCompleteNotification())
  session.pendingTerminalBellNotification = false
  finish(() => session.clearTerminalBellNotificationTimer())
  finish(() => session.clearReattachIdleAgentCursorResetTimer())
  finish(() => session.cleanupHiddenOutputRestoreDeferredRetry())
  finish(() => session.cleanupHiddenOutputRestoreForegroundDeadline())
  finish(() => session.cleanupHiddenOutputRestoreFloodRepaint())
  finish(() => session.flushRemoteProgramRedraw())
  const unregisterBacklogRecovery = session.unregisterBacklogRecovery
  session.unregisterBacklogRecovery = null
  finish(() => unregisterBacklogRecovery?.())
  const unregisterDocumentVisibilityRecovery = session.unregisterDocumentVisibilityRecovery
  session.unregisterDocumentVisibilityRecovery = null
  finish(() => unregisterDocumentVisibilityRecovery?.())
  finish(() => releaseRendererPtyVisibilityClaim(session.transport))
  // Why: the pane's fact consumer must be gone before a parked-tab watcher takes over this PTY's facts in the same effect flush.
  finish(() => session.dropSideEffectFactConsumer())
  finish(() => session.clearPanePtyFitBinding())
  finish(() => discardTerminalOutput(session.pane.terminal))
  finish(() => session.unregisterE2ePtyDataInjection())
  if (session.agentTaskCompleteSettingsUnsubscribe !== null) {
    const agentTaskCompleteSettingsUnsubscribe = session.agentTaskCompleteSettingsUnsubscribe
    session.agentTaskCompleteSettingsUnsubscribe = null
    finish(() => agentTaskCompleteSettingsUnsubscribe?.())
  }
  if (session.unsubscribeWindowsDoneTerminalModeReset !== null) {
    const unsubscribeWindowsDoneTerminalModeReset = session.unsubscribeWindowsDoneTerminalModeReset
    session.unsubscribeWindowsDoneTerminalModeReset = null
    finish(() => unsubscribeWindowsDoneTerminalModeReset?.())
  }
  if (session.connectFrame !== null) {
    // Why: cancel the queued connect frame so a disposed pane (StrictMode/split-group remount) can't reattach the PTY and steal the live pane's handler wiring.
    finish(() => session.cancelScheduledConnectFrame?.())
  }
  if (session.connectFallbackTimer !== null) {
    clearTimeout(session.connectFallbackTimer)
    session.connectFallbackTimer = null
  }
  finish(() => session.imeCompositionRouteDisposable.dispose())
  finish(() => session.userInputActivityDisposable?.dispose())
  finish(() => session.terminalCapabilityRepliesDisposable.dispose())
  finish(() => session.onResizeDisposable.dispose())
  finish(() =>
    session.pane.container.removeEventListener(
      PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
      session.onHeldPtyResizeFlush
    )
  )
  finish(() => session.geometryReportObserver?.disconnect())
  if (session.pendingGeometryReportRaf !== null) {
    cancelAnimationFrame(session.pendingGeometryReportRaf)
    session.pendingGeometryReportRaf = null
  }
  finish(() => session.commandLifecycle.dispose())
  session.deferredCommandFinishedStatusDrop = null
  session.visibleForegroundSamplePending = false
  session.visibleForegroundSampleSettled = false
  finish(() => session.paneForegroundAgentTracker.dispose())
  finish(() => session.agentCompletionCoordinator.dispose())
  if (failure !== undefined) {
    throw failure
  }
}
