import { installPtyKittyFileReader } from './pty-kitty-file-reader'
import { installSpawnDeferredSleep } from './spawn-deferred-sleep'
import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { buildWindowsPtyCompatibilityOptions } from '@/lib/pane-manager/windows-pty-compatibility'
import { buildTerminalKeyboardProtocolOptions } from '@/lib/pane-manager/terminal-keyboard-protocol'
import { resolvePaneKeyboardProtocolAgent } from '../terminal-keyboard-protocol-pane-agent'
import { TerminalKittyKeyboardModeTracker } from '../../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { PtyConnectionDeps } from '../pty-connection-types'
import { registerTerminalPaneRecoveryInstance } from '../terminal-pane-recovery'
import { captureTabRecoveryGeneration } from '@/store/terminals/terminal-tab-recovery-ledger'
import { TerminalIdleCursorReset } from '../terminal-idle-cursor-reset'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { createTerminalStructuralReplayCoordinator } from '@/lib/pane-manager/terminal-structural-replay-coordinator'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'

import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { exposeE2eTerminalPtyOutputDebug } from './e2e-terminal-pty-harness'
import type { PanePtyBinding } from './pane-pty-binding'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import {
  isAgentTaskCompleteNotificationEnabled,
  isAgentTaskCompleteTrackingEnabled
} from './agent-task-complete-settings'

import { installRunDeferredConnect } from './run-deferred-connect'

import { installSleepingRecordAccess } from './sleeping-record-access'
import { installShellCommandInference } from './shell-command-inference'
import { installInterruptInputIntent } from './interrupt-input-intent'
import { installTerminalKeydownFit } from './terminal-keydown-fit'
import { installPtyExitHibernate } from './pty-exit-hibernate'
import { installTitleSpawnBell } from './title-spawn-bell'
import { installAgentTaskCompleteNotify } from './agent-task-complete-notify'
import { installPaneHostCapabilityFlags } from './pane-host-capability-flags'
import { installPtyInputRecovery } from './pty-input-recovery'
import { installAgentPreReadyTypedDraft } from './agent-pre-ready-typed-draft'
import { installPtyInputForward } from './pty-input-forward'
import { installPtyResizeGeometry } from './pty-resize-geometry'
import { installSessionReconcileDispose } from './session-reconcile-dispose'
import { findTerminalTabForPane } from './terminal-tab-id'

export function connectPanePty(
  pane: ManagedPane,
  manager: PaneManager,
  deps: PtyConnectionDeps
): PanePtyBinding {
  const session = { pane, manager, deps } as ConnectPanePtySession
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
    const titleAgentType = resolveCommittedTitleAgentType(title ?? '')
    session.suppressNativeWindowsIdleCodexFocusReports =
      agentType && agentType !== 'unknown' ? agentType === 'codex' : titleAgentType === 'codex'
  }
  // Idle callbacks precede deferred setup; switch from the shared scheduler to the PTY writer to preserve hidden-byte ordering and recovery.
  session.idleCursorReset = new TerminalIdleCursorReset()
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
  // Consume startup once from this shallow-copied deps; callers must clear their separate outer reference.
  session.paneStartup = session.deps.startup ?? null
  if (session.paneStartup?.resumeOrigin === 'saved') {
    session.paneStartup.resumeSource ??= { cancelled: false }
  }
  session.deps.startup = undefined
  // Hold replacement PTY retirement until main takes it in a spawn request or disposal kills it.
  session.pendingReplacedPtyId = session.deps.replacesPtyId ?? null
  // Why: the first spawn claims the PTY, but a deferred retry is still the same user restart.
  session.userRestart = session.pendingReplacedPtyId !== null
  session.deps.replacesPtyId = undefined
  session.claimPendingReplacedPtyId = (): string | null => {
    const ptyId: string | null = session.pendingReplacedPtyId
    session.pendingReplacedPtyId = null
    return ptyId
  }

  // Use stable leaf UUIDs for keys crossing env, hook IPC and replay; numeric pane IDs are renderer-local.
  session.cacheKey = makePaneKey(session.deps.tabId, session.pane.leafId)
  installSleepingRecordAccess(session)
  installShellCommandInference(session)
  installInterruptInputIntent(session)
  installTerminalKeydownFit(session)
  installPtyExitHibernate(session)
  installSpawnDeferredSleep(session)
  installTitleSpawnBell(session)
  installAgentTaskCompleteNotify(session)
  const backendContext = {
    userAgent: navigator.userAgent,
    osRelease: window.api.platform?.get?.()?.osRelease,
    connectionId: session.ownerContext.connectionId,
    cwd: session.deps.cwd,
    shellOverride: session.tab?.shellOverride,
    executionHostId: session.ownerContext.executionHostId,
    tuiAgent: resolvePaneKeyboardProtocolAgent(session.paneStartup, session.tab?.launchAgent)
  }
  // Capture backend policy before the tracker and transport copy xterm's initial capability flags.
  Object.assign(
    session.pane.terminal.options,
    buildWindowsPtyCompatibilityOptions(backendContext),
    buildTerminalKeyboardProtocolOptions(backendContext)
  )
  // xterm exposes no Kitty read; mirror the flags its encoder applies.
  session.kittyKeyboardModes = (() => {
    const existing = session.deps.paneKittyKeyboardModesRef.current.get(session.pane.id)
    if (existing) {
      return existing
    }
    const created = new TerminalKittyKeyboardModeTracker({
      kittyKeyboard: session.pane.terminal.options.vtExtensions?.kittyKeyboard === true
    })
    session.deps.paneKittyKeyboardModesRef.current.set(session.pane.id, created)
    return created
  })()
  installPaneHostCapabilityFlags(session)
  installPtyInputRecovery(session)
  installAgentPreReadyTypedDraft(session)
  // Async callbacks may outlive PaneManager; use durable leaf identity and require current transport ownership.
  const isCurrentPaneTransport = (): boolean =>
    !session.disposed &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
  session.syncPanePtyLayoutBinding = (ptyId: string | null): void => {
    if (!isCurrentPaneTransport()) {
      return
    }
    if (session.deps.syncPanePtyLayoutBindingForLeaf) {
      session.deps.syncPanePtyLayoutBindingForLeaf(session.pane.leafId, ptyId, session.pane.id)
      return
    }
    session.deps.syncPanePtyLayoutBinding(session.pane.id, ptyId)
  }
  session.clearExitedPanePtyLayoutBinding = (exitedPtyId: string): void => {
    if (!isCurrentPaneTransport()) {
      return
    }
    if (session.deps.clearExitedPanePtyLayoutBindingForLeaf) {
      session.deps.clearExitedPanePtyLayoutBindingForLeaf(session.pane.leafId, exitedPtyId)
      return
    }
    session.deps.clearExitedPanePtyLayoutBinding(session.pane.id, exitedPtyId)
  }
  installPtyKittyFileReader(session)
  installPtyInputForward(session)
  installPtyResizeGeometry(session)
  installRunDeferredConnect(session)
  return installSessionReconcileDispose(session)
}
