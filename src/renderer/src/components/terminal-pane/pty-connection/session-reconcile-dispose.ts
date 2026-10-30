import { disposePanePtySession } from './dispose-pane-pty-session'
import { useAppStore } from '@/store'
import { consumeRestartReplacement } from './restart-replacement-on-show'
import { shouldReconcileMissingSession, type HasPty } from '../terminal-dead-session-reconcile'
import { getProviderSessionClaimKey } from '@/lib/sleeping-agent-pane-ownership'

import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { SHIFT_ENTER_RECONFIRM_IDLE_MS } from './foreground-output-scan'
import type { PanePtyBinding } from './pane-pty-binding'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { noteArmsHibernatedPaneWake } from './pty-exit-hibernate'

export function installSessionReconcileDispose(session: ConnectPanePtySession): PanePtyBinding {
  session.reconcileIfSessionMissing = (
    hasPty: HasPty,
    livenessRequestedAt = performance.now()
  ): void => {
    const requestedPtyId = session.transport.getPtyId()
    if (
      !requestedPtyId ||
      requestedPtyId === session.handledExitPtyId ||
      isRemoteRuntimePtyId(requestedPtyId) ||
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
      session.foregroundGridDriftProbeSettled = false
      session.armVisibleRemoteViewportClaim()
      session.claimPendingVisibleRemoteViewport()
      session.ptySizeReassertion.request({ fit: false })
      session.consumeHibernatedAgentWake()
      consumeRestartReplacement(session)
      session.resumeDeferredSpawnOnReveal()
      session.mainPaneStartOnReveal?.()
      session.requestKnownWindowsShiftEnterReconfirmation()
      session.sampleVisiblePaneForegroundAgent()
    },
    reassertPtySizeAfterWindowWake() {
      session.foregroundGridDriftProbeSettled = false
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
      // Latch mid-kill mobile wakes only for the exact suppressed PTY, never unrelated stale/manual records.
      const state = useAppStore.getState()
      const recordEntry = session.getSleepingRecordForPane(state)
      const currentPtyId = session.transport.getPtyId()
      if (
        recordEntry &&
        noteArmsHibernatedPaneWake(recordEntry.record) &&
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
    reconcileIfSessionMissing: session.reconcileIfSessionMissing,
    isUntouchedFreshSpawnPty: (ptyId) =>
      session.spawnedFreshPtyId === ptyId && !Number.isFinite(session.lastTerminalInputAt),
    dispose: () => disposePanePtySession(session)
  }
}
