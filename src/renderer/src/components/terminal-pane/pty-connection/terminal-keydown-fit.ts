import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { bindPanePtyId, getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/runtime-terminal-inspection'
import { isFreshNonDoneAgentStatus } from '../../../../../shared/agent-status-types'
import { isCtrlCKeyEvent, isPlainEscapeKeyEvent } from '../agent-interrupt-inference'
import { createAgentCompletionCoordinator } from '../agent-completion-coordinator'
import { dispatchAgentHookTerminalLifecycle } from '../agent-hook-terminal-lifecycle'
import {
  hookLaneOwnsAgentTurnEnds,
  hookLaneTitleTurnEndEvidence
} from '@/hooks/agent-hook-turn-end-ownership'
import { absorbBurstBellForHookOwnedIdle } from './agent-task-complete-notify'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import { registerTerminalSideEffectFactConsumer } from '../terminal-side-effect-facts-handler'

import { isAgentTaskCompleteTrackingEnabled } from './agent-task-complete-settings'
import { isAgentProcessInspectionCostly } from '../agent-process-inspection-cost'
import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'
import { retireLiveAgentRowOnConfirmedProcessExit } from './confirmed-process-exit-row-retire'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Keydown intent, PTY fit binding, side-effect fact consumption, and the agent completion coordinator. */
export function installTerminalKeydownFit(session: ConnectPanePtySession): void {
  session.onTerminalKeyDown = (event: KeyboardEvent): void => {
    if (isPlainEscapeKeyEvent(event)) {
      session.setPendingTerminalInputIntent('plain-escape')
      return
    }
    if (isCtrlCKeyEvent(event)) {
      if (!navigator.userAgent.includes('Mac') && session.pane.terminal.hasSelection()) {
        return
      }
      session.setPendingTerminalInputIntent('ctrl-c')
    }
    // Why: only keydowns that will produce real terminal input reach the sample
    // below; modifier-only presses, autorepeat, and copy chords do not.
    if (
      event.repeat ||
      event.key === 'Alt' ||
      event.key === 'AltGraph' ||
      event.key === 'Control' ||
      event.key === 'Meta' ||
      event.key === 'Shift'
    ) {
      return
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'c' &&
      session.pane.terminal.hasSelection()
    ) {
      return
    }
    // Enter at shell foreground backs up OSC 133;C hooks replaced by shell frameworks; confirm only panes without live agent identity.
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      session.sampleVisiblePaneForegroundAgent()
    }
  }
  // Infer from focused key events; raw bytes conflate Escape with Alt/meta and programmatic writes must not clear status.
  session.terminalKeyTarget = session.pane.terminal.element ?? session.pane.container
  session.terminalKeyTargetSupportsEvents =
    typeof session.terminalKeyTarget?.addEventListener === 'function' &&
    typeof session.terminalKeyTarget?.removeEventListener === 'function'
  if (session.terminalKeyTargetSupportsEvents) {
    session.terminalKeyTarget.addEventListener('keydown', session.onTerminalKeyDown, {
      capture: true
    })
  }

  session.visibleRemoteViewportClaimPtyId = null
  session.pendingVisibleRemoteViewportClaim = false
  session.setPanePtyFitBinding = (ptyId: string): void => {
    bindPanePtyId(session.pane.id, ptyId, session.deps.tabId)
    session.pane.container.dataset.ptyId = ptyId
    if (
      session.deps.isVisibleRef.current &&
      isRemoteRuntimePtyId(ptyId) &&
      session.visibleRemoteViewportClaimPtyId !== ptyId
    ) {
      // Why: the initial fit event consumes this activation arm before later peer ownership changes.
      session.visibleRemoteViewportClaimPtyId = ptyId
      session.pendingVisibleRemoteViewportClaim = true
    }
    // Why: override hydration can arrive before this pane knows its PTY. Once
    // data-pty-id is bound, safeFit can park xterm at the authoritative grid.
    const hasFitOverride = getFitOverrideForPty(ptyId) !== null
    if (hasFitOverride) {
      safeFit(session.pane)
    }
    // Why: the overlay tick skipped that early event (no pane owned this PTY yet),
    // so the parked grid would otherwise show no "sized for your phone" banner.
    if (hasFitOverride || isPtyLocked(ptyId)) {
      session.deps.refreshMobileOverlays?.()
    }
    session.claimPendingVisibleRemoteViewport()
  }
  session.activePanePtyBinding = null
  // Why: bind time lets async liveness reconcile ignore a request started
  // before this PTY bound (newborn race). Null disables the guard (fail-safe).
  session.activePanePtyBindingBoundAt = null

  // Main-authority facts replace byte parsers as the single policy consumer; title snapshots restore metadata without attention replay.
  session.unregisterSideEffectFactConsumer = null
  session.registerSideEffectFactConsumerForPty = (
    ptyId: string,
    remoteOutputPaused = false
  ): void => {
    if ((!session.mainSideEffectAuthority && !remoteOutputPaused) || session.disposed) {
      return
    }
    session.unregisterSideEffectFactConsumer?.()
    session.unregisterSideEffectFactConsumer = registerTerminalSideEffectFactConsumer({
      ptyId,
      callbacks: {
        onTitleChange: session.onTitleChange,
        onBell: session.onBell,
        onAgentBecameIdle: session.onAgentBecameIdle,
        onAgentBecameWorking: session.onAgentBecameWorking,
        onAgentExited: session.onAgentExited,
        onCommandFinished: session.handleCommandFinished,
        onPrLink: (link) =>
          useAppStore
            .getState()
            .observeTerminalGitHubPullRequestLink(session.deps.worktreeId, link, {
              tabId: session.deps.tabId,
              paneKey: makePaneKey(session.deps.tabId, session.pane.leafId),
              ptyId: session.transport.getPtyId(),
              executionHostId: session.transport.getExecutionHostId?.() ?? undefined
            }),
        // Pane policy owns Command Code settling against the live row; main supplies scrape facts only.
        onCommandCodeWorking: session.seedCommandCodeOutputWorkingStatus,
        onCommandCodeDone: session.scheduleCommandCodeOutputDoneStatus,
        ...(session.shouldOwnAgentStatusInRenderer
          ? { onAgentStatus: (payload) => session.handleRendererOwnedAgentStatus(payload) }
          : {}),
        // Why: gated hidden panes never see the subscribe bytes; the fact
        // replaces the byte scan (and the old post-latch subscribe drop).
        ...(session.hiddenDeliveryGateActive || remoteOutputPaused
          ? {
              onMode2031Subscribe: session.handleHiddenMode2031SubscribeFact,
              onMode2031Unsubscribe: session.handleHiddenMode2031UnsubscribeFact
            }
          : {})
      },
      restoreTitleOnRegister: true
    })
  }
  session.dropSideEffectFactConsumer = (): void => {
    session.unregisterSideEffectFactConsumer?.()
    session.unregisterSideEffectFactConsumer = null
    session.remoteOutputFactConsumerPtyId = null
  }
  session.clearPanePtyFitBinding = (): void => {
    // Clear module-level fit bindings explicitly; DOM removal cannot release them.
    bindPanePtyId(session.pane.id, null, session.deps.tabId)
    session.visibleRemoteViewportClaimPtyId = null
    session.pendingVisibleRemoteViewportClaim = false
    session.activePanePtyBinding = null
    session.activePanePtyBindingBoundAt = null
    delete session.pane.container.dataset.ptyId
    delete session.pane.container.dataset.ptyRecoveryState
  }

  session.agentCompletionCoordinator = createAgentCompletionCoordinator({
    paneKey: session.cacheKey,
    statusLane: 'pty',
    getPtyId: () => session.transport.getPtyId(),
    isRemotePtyId: isRemoteExecutionHostPtyId,
    getExpectedIncarnationId: () => session.remotePtyIncarnationId ?? null,
    inspectProcess: inspectRuntimeTerminalProcess,
    confirmForegroundProcess: confirmRuntimeTerminalForegroundProcess,
    dispatchHookLifecycle: (payload) =>
      dispatchAgentHookTerminalLifecycle(session.cacheKey, payload),
    titleTurnEndEvidence: (title, foregroundAgent) =>
      hookLaneTitleTurnEndEvidence(
        session.cacheKey,
        session.transport.getPtyId(),
        title,
        foregroundAgent
      ),
    onHookOwnedTitleIdle: () => absorbBurstBellForHookOwnedIdle(session),
    shouldSuppressProcessReplacementCompletion: (exited, replacement) => {
      // Why: the hook lane owns this pane's turn ends and its last turn ended, so quitting ends none.
      if (hookLaneOwnsAgentTurnEnds(session.cacheKey, session.transport.getPtyId(), exited.agent)) {
        return true
      }
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      const currentAgentForReplacement = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        replacement.agent
      )
      return (
        isFreshNonDoneAgentStatus(currentStatus) && currentAgentForReplacement === replacement.agent
      )
    },
    shouldSuppressConfirmedProcessExitCompletion: (exited) => {
      if (hookLaneOwnsAgentTurnEnds(session.cacheKey, session.transport.getPtyId(), exited.agent)) {
        return true
      }
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      const currentAgentForExited = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        exited.agent
      )
      // Why: a replacement hook can lead process visibility by one cadence;
      // only a different known active owner can veto confirmed old-process exit.
      return Boolean(
        isFreshNonDoneAgentStatus(currentStatus) &&
        currentStatus.agentType &&
        currentStatus.agentType !== 'unknown' &&
        currentAgentForExited !== exited.agent
      )
    },
    // Why: the pane's only re-derivation of a process read where the shell emits no command marks.
    onForegroundAgentExited: (exited) => {
      session.paneForegroundAgentTracker?.onProcessExitConfirmed(exited)
      // Why: not behind the tracker's process-read guard, so hook-identified panes retire too.
      retireLiveAgentRowOnConfirmedProcessExit(session, exited)
    },
    dispatchCompletion: (title, meta) => {
      if (meta?.source === 'process-exit') {
        session.clearSuppressedTitleSideEffects()
      }
      if (meta?.terminalIdleConfirmed === true) {
        // Why: an agent can crash before its done hook; confirmed process death
        // must still restore cursor and native Windows Kitty keyboard modes.
        const currentAgentStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
        if (!isFreshNonDoneAgentStatus(currentAgentStatus)) {
          session.setFocusReportSuppressionForAgentCompletion(title, meta.agentStatus?.agentType)
        }
        session.queueAgentIdleTerminalModeReset()
      }
      session.scheduleAgentTaskCompleteNotification(title, {
        allowDoneDetailAfterGrace: meta?.quietedHookDone,
        ...(meta?.source === 'process-exit' ? { agentCompletionSource: meta.source } : {}),
        ...(meta?.agentStatus ? { agentStatusSnapshot: meta.agentStatus } : {})
      })
    },
    dispatchAttention: (title, meta) =>
      session.scheduleAgentTaskCompleteNotification(title, {
        agentStatusSnapshot: meta.agentStatus
      }),
    shouldPollProcessCadence: () => {
      const ptyId = session.transport.getPtyId()
      if (isRemoteExecutionHostPtyId(ptyId)) {
        return false
      }
      return isAgentTaskCompleteTrackingEnabled() && session.deps.isVisibleRef.current
    },
    shouldPollNoEvidenceProcessCadence: () => {
      const ptyId = session.transport.getPtyId()
      return !isRemoteExecutionHostPtyId(ptyId)
    },
    isProcessInspectionCostly: () => isAgentProcessInspectionCostly(session.transport.getPtyId()),
    isLive: () => {
      if (session.disposed) {
        return false
      }
      if (session.transport.getPtyId()) {
        return true
      }
      return (useAppStore.getState().ptyIdsByTabId[session.deps.tabId] ?? []).length > 0
    }
  })
}
