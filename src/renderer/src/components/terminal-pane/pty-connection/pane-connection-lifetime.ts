import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { PtyConnectionDeps } from './pty-connection-deps'
import { useAppStore } from '@/store'
import { registerTerminalPaneRecoveryInstance } from '../render-health/recovery/terminal-pane-recovery'
import { captureTabRecoveryGeneration } from '@/store/terminals/terminal-tab-recovery-ledger'
import { TerminalIdleCursorReset } from '../emulation/terminal-idle-cursor-reset'
import { TerminalStreamPosition } from '../pty-transport/delivery/terminal-stream-position'
import { writeTerminalOutput } from '@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler'
import { createTerminalStructuralReplayCoordinator } from '@/lib/pane-manager/terminal-replay/terminal-structural-replay-coordinator'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { resolveExplicitTerminalTitleAgentType } from '../../../../../shared/agent-status/title/terminal-title-agent-type'
import { shouldWritePtyOutputForeground } from './output/foreground-output-visibility'
import { exposeE2eTerminalPtyOutputDebug } from './instrumentation/e2e-terminal-pty-harness'
import { findTerminalTabForPane } from './terminal-tab-id'
import {
  isAgentTaskCompleteNotificationEnabled,
  isAgentTaskCompleteTrackingEnabled
} from './notifications/agent-task-complete-settings'

export function initializePaneConnectionLifetime(
  session: ConnectPanePtySession,
  deps: PtyConnectionDeps
): void {
  session.shouldRefreshForegroundSynchronously = (): boolean =>
    !session.manager.hasWebglRenderer(session.pane.id)
  // Resolve both remount and recovery epochs from one row to avoid a second global tab scan.
  const terminalTab = findTerminalTabForPane(useAppStore.getState(), deps.worktreeId, deps.tabId)
  session.tabGeneration = terminalTab?.generation ?? 0
  // Recovery belongs to this xterm instance; late requests cannot replace its already-remounted successor.
  session.terminalRecoveryGeneration = captureTabRecoveryGeneration(terminalTab)
  session.terminalRecoveryInstance = registerTerminalPaneRecoveryInstance(session.deps.tabId)
  session.mountFollowsTerminalPark = session.deps.mountFollowsTerminalPark
  session.authoritativeReattachGeneration = 0
  exposeE2eTerminalPtyOutputDebug()
  session.disposed = false
  session.structuralReplayCoordinator = createTerminalStructuralReplayCoordinator(
    session.pane.terminal
  )
  session.connectFrame = null
  session.connectFallbackTimer = null
  session.connectStarted = false
  session.unregisterBacklogRecovery = null
  session.unregisterDocumentVisibilityRecovery = null
  session.cancelHiddenOutputSnapshotScrollRestore = (): void => {}
  session.pendingHiddenSnapshotFit = null
  session.pendingReattachFit = null
  session.cancelFreshSpawnFollowReset = (): void => {}
  session.cleanupHiddenOutputRestoreDeferredRetry = (): void => {}
  session.cleanupHiddenOutputRestoreForegroundDeadline = (): void => {}
  session.cleanupHiddenOutputRestoreFloodRepaint = (): void => {}
  session.flushRemoteProgramRedraw = (): void => {}
  session.resetRendererOrderedSeqForPtyExit = () => {}
  session.cleanupStartupDraftPasteTimers = (): void => {}
  session.unregisterE2ePtyDataInjection = (): void => {}
  session.startupInjectTimer = null
  session.agentTaskCompleteNotificationGraceTimer = null
  session.agentTaskCompleteNotificationMaxTimer = null
  session.hookOwnedIdleAbsorbsBell = false
  session.agentTaskCompleteStatusUnsubscribe = null
  session.agentTaskCompleteSettingsUnsubscribe = null
  session.agentTaskCompleteNotificationGeneration = 0
  session.wasAgentTaskCompleteTrackingEnabled = isAgentTaskCompleteTrackingEnabled()
  session.requiresFreshWorkingForAgentTaskCompleteNotification =
    !session.wasAgentTaskCompleteTrackingEnabled
  session.wasAgentTaskCompleteOsNotificationEnabled = isAgentTaskCompleteNotificationEnabled()
  session.terminalBellNotificationTimer = null
  session.pendingTerminalBellNotification = false
  session.reattachIdleAgentCursorResetTimer = null
  session.shiftEnterReconfirmTimer = null
  session.synchronizedForegroundOutputActive = false
  // Why: carries up to one marker-length-1 of trailing bytes so a ConPTY-split DEC 2026 marker is still detected (#8754).
  session.synchronizedForegroundMarkerTail = ''
  // Classify latency at frame open so ConPTY-split closing markers retain the fast drain after the keystroke window.
  session.synchronizedForegroundFrameInteractive = false
  session.synchronizedForegroundInteractivePresentPending = false
  session.suppressStructuralReplayPtyResize = false
  // Lifecycle can precede deferred output setup; initialize hidden-delivery callbacks as no-ops.
  session.syncHiddenRendererPtyDelivery = () => {}
  session.releaseHiddenRendererPtyDelivery = () => {}
  session.handleRemoteOutputPauseChanged = () => {}
  session.handleRemotePausedOutputDropped = () => {}
  session.handleRendererOwnedAgentStatus = () => {}
  session.remoteOutputGatedPtyId = null
  session.remoteOutputFactConsumerPtyId = null
  session.suppressViewportClaimTerminalResize = false
  session.suppressNativeWindowsIdleCodexFocusReports = false
  session.setFocusReportSuppressionForAgentCompletion = (
    title: string | undefined,
    agentType: AgentType | undefined
  ): void => {
    const titleAgentType = resolveExplicitTerminalTitleAgentType(title ?? '')
    session.suppressNativeWindowsIdleCodexFocusReports =
      agentType && agentType !== 'unknown' ? agentType === 'codex' : titleAgentType === 'codex'
  }
  // Idle callbacks precede deferred setup; switch from the shared scheduler to the PTY writer to preserve hidden-byte ordering and recovery.
  session.idleCursorReset = new TerminalIdleCursorReset()
  session.streamPosition = new TerminalStreamPosition()
  session.skippedQueryCarry = null
  session.queueAgentIdleTerminalModeReset = (): void => {
    if (session.disposed) {
      return
    }
    const reset = session.idleCursorReset.request()
    if (reset) {
      writeTerminalOutput(session.pane.terminal, reset, {
        foreground: shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
      })
    }
  }
  // Dispose actively unsubscribes and resolves passphrase waits; disconnected stores may never emit to release them.
  session.waitTeardowns = []
}
