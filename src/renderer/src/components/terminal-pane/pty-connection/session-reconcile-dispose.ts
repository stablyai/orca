import { useAppStore } from '@/store'
import {
  shouldReconcileDeadSession,
  shouldReconcileMissingSession,
  type HasPty
} from '../terminal-dead-session-reconcile'
import { cancelPendingSafeFitContinuations } from '@/lib/pane-manager/pane-tree-ops'
import { PANE_PTY_RESIZE_HOLD_FLUSH_EVENT } from '@/lib/pane-manager/pane-pty-resize-hold'
import { discardTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import {
  getProviderSessionClaimKey,
  isPassiveCompletedHibernationEvidence
} from '@/lib/sleeping-agent-pane-ownership'
import { releaseRendererPtyVisibilityClaim } from '../pty-renderer-delivery-claims'

import { REMOTE_PTY_ID_PREFIX } from './pty-connect-limits'
import { SHIFT_ENTER_RECONFIRM_IDLE_MS } from './foreground-output-scan'
import type { PanePtyBinding } from './pane-pty-binding'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installSessionReconcileDispose(session: ConnectPanePtySession): PanePtyBinding {
  session.reconcileIfSessionDead = (
    liveSessionIds: Set<string>,
    snapshotRequestedAt?: number
  ): void => {
    if (session.disposed) {
      return
    }
    const currentPtyId = session.transport.getPtyId()
    if (
      !currentPtyId ||
      // Why: this exit was already handled — onExit guards it too, but skipping here avoids a redundant shouldReconcile evaluation.
      session.handledExitPtyId === currentPtyId ||
      !shouldReconcileDeadSession({
        ptyId: currentPtyId,
        connectionId: session.transport.getConnectionId?.(),
        liveSessionIds,
        ptyBoundAt: session.activePanePtyBindingBoundAt,
        snapshotRequestedAt
      })
    ) {
      return
    }
    session.onExit(currentPtyId)
  }

  session.reconcileIfSessionMissing = (
    hasPty: HasPty,
    livenessRequestedAt = performance.now()
  ): void => {
    const requestedPtyId = session.transport.getPtyId()
    if (
      !requestedPtyId ||
      requestedPtyId === session.handledExitPtyId ||
      requestedPtyId.startsWith(REMOTE_PTY_ID_PREFIX) ||
      session.transport.getConnectionId?.() != null
    ) {
      return
    }

    let livenessPromise: Promise<boolean | null>
    try {
      livenessPromise = Promise.resolve(hasPty(requestedPtyId))
    } catch {
      return
    }

    void livenessPromise
      .then((isLive) => {
        if (session.disposed) {
          return
        }
        const currentPtyId = session.transport.getPtyId()
        if (
          !currentPtyId ||
          currentPtyId !== requestedPtyId ||
          session.handledExitPtyId === currentPtyId ||
          !shouldReconcileMissingSession({
            ptyId: currentPtyId,
            connectionId: session.transport.getConnectionId?.(),
            isLive,
            ptyBoundAt: session.activePanePtyBindingBoundAt,
            livenessRequestedAt
          })
        ) {
          return
        }
        session.onExit(currentPtyId)
      })
      .catch(() => {})
  }

  return {
    syncProcessTracking() {
      session.agentCompletionCoordinator.startProcessTracking()
      // Why: the hidden-delivery gate must follow every pane visibility flip.
      session.syncHiddenRendererPtyDelivery()
      if (!session.deps.isVisibleRef.current) {
        session.pendingVisibleRemoteViewportClaim = false
      }
    },
    // Why: visible-resume size readback repairs dropped hidden resizes without refitting against xterm's transient hidden DOM fallback.
    noteVisibilityResume() {
      session.armVisibleRemoteViewportClaim()
      session.claimPendingVisibleRemoteViewport()
      session.ptySizeReassertion.request({ fit: false })
      session.consumeHibernatedAgentWake()
      session.requestKnownWindowsShiftEnterReconfirmation()
      session.sampleVisiblePaneForegroundAgent()
    },
    reassertPtySizeAfterWindowWake() {
      session.armVisibleRemoteViewportClaim()
      session.claimPendingVisibleRemoteViewport()
      session.ptySizeReassertion.request({ fit: false })
    },
    // Why: mobile wake reaches this pane while it's hidden on the desktop, so consume only the armed hibernation wake — no size/foreground reads.
    wakeHibernatedAgentIfArmed(claimedProviderSessions) {
      if (session.hibernatedWakeInFlightClaimKey) {
        if (claimedProviderSessions?.has(session.hibernatedWakeInFlightClaimKey)) {
          return null
        }
        claimedProviderSessions?.add(session.hibernatedWakeInFlightClaimKey)
        return session.hibernatedWakeInFlightClaimKey
      }
      const consumedClaimKey = session.consumeHibernatedAgentWake(claimedProviderSessions)
      if (consumedClaimKey) {
        return consumedClaimKey
      }
      // Why: wake arrived mid-hibernation-kill before onExit armed the wake target (transport still bound to the dying PTY).
      // Only the exact PTY marked for suppressed shutdown may latch — never a stale/manual record beside an ordinary live PTY.
      const state = useAppStore.getState()
      const recordEntry = session.getSleepingRecordForPane(state)
      const currentPtyId = session.transport.getPtyId()
      if (
        recordEntry &&
        isPassiveCompletedHibernationEvidence(recordEntry.record) &&
        currentPtyId !== null &&
        state.suppressedPtyExitIds[currentPtyId] === true &&
        !session.disposed &&
        session.hibernatedWakeTarget === null &&
        session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
        session.transport.getPtyId() === currentPtyId
      ) {
        const claimKey = getProviderSessionClaimKey(recordEntry.record)
        if (claimedProviderSessions?.has(claimKey)) {
          return null
        }
        claimedProviderSessions?.add(claimKey)
        session.pendingHibernatedWakeTarget = { ptyId: currentPtyId, record: recordEntry.record }
        return claimKey
      }
      return null
    },
    sampleForegroundAgentOnFocus() {
      session.requestKnownWindowsShiftEnterReconfirmation()
      session.sampleVisiblePaneForegroundAgent()
    },
    requestWindowsShiftEnterReconfirmation() {
      if (session.shiftEnterReconfirmTimer !== null) {
        clearTimeout(session.shiftEnterReconfirmTimer)
      }
      // Why: confirm the composer only after the Shift+Enter burst goes idle, preserving rapid multiline input.
      session.shiftEnterReconfirmTimer = setTimeout(() => {
        session.shiftEnterReconfirmTimer = null
        session.requestKnownWindowsShiftEnterReconfirmation()
        session.sampleVisiblePaneForegroundAgent()
      }, SHIFT_ENTER_RECONFIRM_IDLE_MS)
    },
    markShortcutTerminalInputSent() {
      session.markInteractiveRedrawInput()
    },
    reconcileIfSessionDead: session.reconcileIfSessionDead,
    reconcileIfSessionMissing: session.reconcileIfSessionMissing,
    dispose() {
      session.disposed = true
      // Why: a detached client stops observing the pane's bytes, so it must cede
      // agent-status authority back to the host on the next mirrored snapshot.
      session.releaseRendererOwnedAgentStatusPane?.()
      session.directSshPaneRetrySettlementCancelled = true
      for (const timer of session.directSshPaneRetrySettlementTimers) {
        clearTimeout(timer)
      }
      session.directSshPaneRetrySettlementTimers.clear()
      // Why: a stalled xterm replay may never reach its finally; release live-frame credit when this renderer no longer owns the stream.
      const queue = session.deferredReattachLiveData
      session.deferredReattachLiveData = null
      queue?.discard()
      session.reattachLiveDataDeferralDepth = 0
      session.deferredReattachLiveDataOwners = new Map()
      cancelPendingSafeFitContinuations(session.pane)
      session.pendingHiddenSnapshotFit = null
      session.pendingReattachFit = null
      // Why: park/reconnect/remount doesn't advance the recovery epoch, so invalidate this xterm or its delayed retry could hit the next instance.
      session.terminalRecoveryInstance.unregister()
      session.unregisterUndeliverableWriteHandler()
      session.unsubscribeRemoteDesktopActivationClaim()
      session.cancelHiddenOutputSnapshotScrollRestore()
      session.liveScrollbackRestore?.dispose()
      session.liveScrollbackRestore = null
      session.structuralReplayCoordinator.dispose()
      session.cancelFreshSpawnFollowReset()
      // Why: cancel the post-spawn reconcile's pending rAF so a torn-down pane can't keep fitting/resizing after disposal.
      session.ptySizeReconcileHandle?.cancel()
      session.ptySizeReconcileHandle = null
      session.startupGridSettleHandle?.cancel()
      session.startupGridSettleHandle = null
      session.ptySizeReassertion.dispose()
      if (session.pendingForegroundGridDriftCheckRaf !== null) {
        cancelAnimationFrame(session.pendingForegroundGridDriftCheckRaf)
        session.pendingForegroundGridDriftCheckRaf = null
      }
      // Why: a pane unmount must never leave its PTY delivery gated — the parked watcher or remounted pane re-decides.
      session.releaseHiddenRendererPtyDelivery()
      if (session.terminalKeyTargetSupportsEvents) {
        session.terminalKeyTarget.removeEventListener('keydown', session.onTerminalKeyDown, {
          capture: true
        })
      }
      session.clearPendingTerminalInputIntent()
      session.pendingTerminalInputWrite = null
      session.interruptInference.dispose()
      session.clearTitleOnlyInterruptTimer()
      // Why release, not cancel: the pending settle belongs to the turn, not to
      // this pane — a park mid-settle hands it to the parked watcher instead.
      session.releaseCommandCodeDoneSettleExecutor()
      if (session.shiftEnterReconfirmTimer !== null) {
        clearTimeout(session.shiftEnterReconfirmTimer)
        session.shiftEnterReconfirmTimer = null
      }
      // Why: resolve in-flight passphrase-gate waits so their zustand subscribers + async IIFEs don't hang when the pane is torn down before SSH state changes.
      while (session.waitTeardowns.length > 0) {
        const teardown = session.waitTeardowns.pop()
        teardown?.()
      }
      if (session.startupInjectTimer !== null) {
        clearTimeout(session.startupInjectTimer)
        session.startupInjectTimer = null
      }
      session.cleanupStartupDraftPasteTimers()
      session.releaseUnattemptedStartupDraftPasteDelivery()
      session.unregisterAgentHookTerminalLifecycle()
      session.clearSuppressedTitleSideEffects()
      session.clearPendingAgentTaskCompleteNotification()
      session.pendingTerminalBellNotification = false
      session.clearTerminalBellNotificationTimer()
      session.clearReattachIdleAgentCursorResetTimer()
      if (session.alternateScreenBackgroundRepaintTimer !== null) {
        clearTimeout(session.alternateScreenBackgroundRepaintTimer)
        session.alternateScreenBackgroundRepaintTimer = null
      }
      session.cleanupHiddenOutputRestoreDeferredRetry()
      session.cleanupHiddenOutputRestoreForegroundDeadline()
      session.cleanupHiddenOutputRestoreFloodRepaint()
      session.unregisterBacklogRecovery?.()
      session.unregisterBacklogRecovery = null
      session.unregisterDocumentVisibilityRecovery?.()
      session.unregisterDocumentVisibilityRecovery = null
      releaseRendererPtyVisibilityClaim(session.transport)
      // Why: the pane's fact consumer must be gone before a parked-tab watcher takes over this PTY's facts in the same effect flush.
      session.dropSideEffectFactConsumer()
      session.clearPanePtyFitBinding()
      discardTerminalOutput(session.pane.terminal)
      session.unregisterE2ePtyDataInjection()
      if (session.agentTaskCompleteSettingsUnsubscribe !== null) {
        session.agentTaskCompleteSettingsUnsubscribe()
        session.agentTaskCompleteSettingsUnsubscribe = null
      }
      if (session.unsubscribeWindowsDoneTerminalModeReset !== null) {
        session.unsubscribeWindowsDoneTerminalModeReset()
        session.unsubscribeWindowsDoneTerminalModeReset = null
      }
      if (session.connectFrame !== null) {
        // Why: cancel the queued connect frame so a disposed pane (StrictMode/split-group remount) can't reattach the PTY and steal the live pane's handler wiring.
        session.cancelScheduledConnectFrame()
      }
      if (session.connectFallbackTimer !== null) {
        clearTimeout(session.connectFallbackTimer)
        session.connectFallbackTimer = null
      }
      session.imeCompositionRouteDisposable.dispose()
      session.onDataDisposable.dispose()
      session.userInputActivityDisposable?.dispose()
      session.terminalCapabilityRepliesDisposable.dispose()
      session.onResizeDisposable.dispose()
      session.pane.container.removeEventListener(
        PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
        session.onHeldPtyResizeFlush
      )
      session.geometryReportObserver?.disconnect()
      if (session.pendingGeometryReportRaf !== null) {
        cancelAnimationFrame(session.pendingGeometryReportRaf)
        session.pendingGeometryReportRaf = null
      }
      session.commandLifecycle.dispose()
      session.deferredCommandFinishedStatusDrop = null
      session.visibleForegroundSamplePending = false
      session.visibleForegroundSampleSettled = false
      session.paneForegroundAgentTracker.dispose()
      session.agentCompletionCoordinator.dispose()
    }
  }
}
